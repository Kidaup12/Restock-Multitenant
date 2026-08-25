import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A `"use server"` module may export async functions and nothing else.
 *
 * Next turns every export of such a file into a callable endpoint, so a
 * constant or a plain object there throws `A "use server" file can only export
 * async functions, found object` — at module evaluation, in the browser, on
 * whichever page imports it. Nothing before that sees it: the types are fine,
 * the linter is fine, and the whole suite is fine, because the rule belongs to
 * the framework's build rather than to TypeScript. One shared constant beside
 * an action was enough to take a settings page down to its error boundary while
 * every gate stayed green.
 *
 * Shared values belong in a normal module the action imports — `@wezesha/db`'s
 * subpaths are where the cross-app ones live.
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

/** `export const`/`let`/`var`/`class`/`enum`, and `export default` of a
 *  non-function. Type-only exports are erased before the build sees them, so
 *  `export type` and `export interface` are deliberately not matched. */
const VALUE_EXPORT =
  /^export\s+(?:const|let|var|class|enum)\s|^export\s+default\s+(?!async\b|function\b)/m;

describe('"use server" modules', () => {
  it("export async functions and nothing else", () => {
    const files = sourceFiles(webRoot);
    expect(files.length, "the source walk found no files to check").toBeGreaterThan(100);

    const serverModules = files.filter((file) => {
      const head = readFileSync(file, "utf8").slice(0, 200);
      return /^\s*["']use server["']/.test(head);
    });
    // If this ever hits zero the rule is guarding nothing and would pass in
    // silence — the app has server actions, so finding none means a broken walk.
    expect(serverModules.length, 'no "use server" modules found — the walk is wrong').
      toBeGreaterThan(0);

    const offenders = serverModules
      .filter((file) => VALUE_EXPORT.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(webRoot, file));

    expect(offenders, "move the value into a module the action imports").toEqual([]);
  });
});
