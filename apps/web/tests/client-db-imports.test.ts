import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Client components may not pull VALUES out of the `@wezesha/db` root: that
 * entry re-exports the Prisma clients, which instantiate on module evaluation
 * and throw on a missing SERVICE_DATABASE_URL — in a browser bundle that kills
 * the component subtree before it hydrates. Runtime tests never see it (they
 * run on node, where the env is set), so the boundary is guarded statically.
 * Browser-safe values live behind subpaths (`@wezesha/db/roles`); `import type`
 * is erased at compile time and is always fine.
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

// Matches one import statement whose specifier is the package root, capturing
// the clause so a leading `type` (the erased, harmless form) can be excluded.
// `[^;]` keeps the match inside a single statement.
const DB_ROOT_IMPORT = /import\s+([^;]*?)\s+from\s+["']@wezesha\/db["']/g;

describe("client/server import boundary", () => {
  it("no \"use client\" file imports values from the @wezesha/db root", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(webRoot)) {
      const source = readFileSync(file, "utf8");
      if (!/^\s*["']use client["']/m.test(source)) continue;

      for (const [, clause] of source.matchAll(DB_ROOT_IMPORT)) {
        // `import type { X }` is erased; `import { type X }` inside a value
        // clause still emits the import, so only the leading form is exempt.
        if (/^type\b/.test(clause.trim())) continue;
        offenders.push(`${path.relative(webRoot, file)}: import ${clause.trim()}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
