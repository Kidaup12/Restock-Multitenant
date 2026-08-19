import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * No screen may use a native browser dialog.
 *
 * `window.confirm` renders as browser chrome: unstyled, in the wrong theme, and
 * captioned with the deployment's hostname rather than the shop's product. It
 * also blocks the renderer, which means every destructive action behind one was
 * unreachable by anything driving a browser — the delete paths could not be
 * exercised at all. `useConfirm` replaces them; this stops them coming back.
 */

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const SKIP = new Set(["node_modules", ".next", "tests"]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return SKIP.has(entry) ? [] : sources(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

/** `prompt()` is excluded deliberately: the PWA install prompt is a browser API
 *  of the same name and is not a dialog we render. */
const NATIVE = /\bwindow\.(confirm|alert)\s*\(|(?<![.\w])(confirm|alert)\s*\(\s*['"`]/;

describe("native browser dialogs", () => {
  const files = [
    ...sources(path.join(webRoot, "app")),
    ...sources(path.join(webRoot, "components")),
  ];

  it("finds the source files at all (guards the walker)", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("are not used anywhere — the app renders its own", () => {
    const offenders = files
      .filter((f) => !f.endsWith("confirm-dialog.tsx"))
      .filter((f) => NATIVE.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(webRoot, f));
    expect(offenders, `use useConfirm() instead:\n${offenders.join("\n")}`).toEqual([]);
  });
});
