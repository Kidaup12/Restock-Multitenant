import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Client components may not pull VALUES out of the `@wezesha/db` root — their
 * own imports or anything they reach through.
 *
 * That entry re-exports the Prisma clients, which instantiate on module
 * evaluation and throw on a missing SERVICE_DATABASE_URL; in a browser bundle
 * that kills the component subtree before it hydrates. Runtime tests never see
 * it (they run on node, where the env is set), so the boundary is guarded
 * statically. Browser-safe values live behind subpaths (`@wezesha/db/roles`);
 * `import type` is erased at compile time and is always fine.
 *
 * The direct check alone was not enough. A dashboard card imported a pure
 * helper as a value; a server read was later added to that helper, which
 * dragged Prisma into the bundle and took the page down — while typecheck,
 * lint, the whole suite and this guard all stayed green. A shared module a
 * client component imports from is part of the client bundle, so the walk
 * follows local imports as far as they go.
 *
 * It stops at `"use server"` modules on purpose: Next replaces those with RPC
 * stubs, so a client component importing a server action bundles no database
 * code. Stopping there is the difference between a guard and a wall of noise.
 */

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", ".next", "tests"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      return SKIP_DIRS.has(entry) ? [] : sourceFiles(full);
    }
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

// One import statement, capturing the clause (so a leading `type` can be
// excluded) and the specifier. `[^;]` keeps the match inside one statement.
const IMPORT = /import\s+([^;]*?)\s+from\s+["']([^"']+)["']/g;

/** `import type { X }` is erased. `import { type X }` inside a value clause
 *  still emits the import, so only the leading form is exempt. */
const isTypeOnly = (clause: string) => /^type\b/.test(clause.trim());

const directive = (source: string, name: string) =>
  new RegExp(`^\s*["']${name}["']`, "m").test(source);

/** Resolve a local specifier to a file on disk, or null if it leaves the app. */
function resolveLocal(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = path.join(webRoot, specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(fromFile), specifier);
  else return null;

  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** The import chain from a client file to a db-root value import, or null. */
function chainToDbRoot(entry: string): string[] | null {
  const seen = new Set<string>();
  const queue: { file: string; trail: string[] }[] = [{ file: entry, trail: [entry] }];

  while (queue.length) {
    const { file, trail } = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);

    const source = readFileSync(file, "utf8");
    // A server action is an RPC boundary, not a bundled import.
    if (file !== entry && directive(source, "use server")) continue;

    for (const [, clause, specifier] of source.matchAll(IMPORT)) {
      if (isTypeOnly(clause)) continue;
      if (specifier === "@wezesha/db") return trail;
      const next = resolveLocal(file, specifier);
      if (next) queue.push({ file: next, trail: [...trail, next] });
    }
  }
  return null;
}

const rel = (file: string) => path.relative(webRoot, file).split(path.sep).join("/");

describe("client/server import boundary", () => {
  const files = sourceFiles(webRoot);

  it("finds the source files at all (guards the walker)", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("no client component reaches a value from the @wezesha/db root", () => {
    const offenders = files
      .filter((file) => directive(readFileSync(file, "utf8"), "use client"))
      .map((file) => chainToDbRoot(file))
      .filter((chain): chain is string[] => chain !== null)
      .map((chain) => chain.map(rel).join("\n    → "));

    expect(offenders, `move the read behind a server module:\n${offenders.join("\n\n")}`).toEqual(
      [],
    );
  });
});
