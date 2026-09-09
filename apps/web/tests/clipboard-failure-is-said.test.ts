import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * A copy that fails says so.
 *
 * `navigator.clipboard.writeText` rejects more often than it looks: on a page
 * the browser does not consider focused, on any non-HTTPS origin, and whenever
 * permission is refused. Both call sites awaited it bare, so the rejection went
 * nowhere — the button un-greyed, the label stayed "Copy", and the person had an
 * empty clipboard and no idea. One of the two is the single moment a POS secret
 * is ever shown, after which it cannot be recovered.
 *
 * A browser sweep found it as an uncaught error and no visible symptom, which is
 * exactly what it would look like to a shop.
 *
 * Coarse on purpose, in the shape the other guards here use: the file that
 * copies must also handle a failure. It cannot prove the message is shown to the
 * right person — read the handler too.
 */

const WEB = path.join(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".tsx") || e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("copying to the clipboard", () => {
  const files = [
    ...walk(path.join(WEB, "app")),
    ...walk(path.join(WEB, "components")),
    ...walk(path.join(WEB, "lib")),
  ];

  it("looked at the app at all", () => {
    expect(files.length, "the walk found no files — it is looking in the wrong place").toBeGreaterThan(
      100
    );
  });

  it("is always guarded against refusal", () => {
    const unguarded = files.filter((f) => {
      const src = readFileSync(f, "utf8");
      if (!src.includes("clipboard.writeText")) return false;
      return !/catch\s*[({]/.test(src);
    });
    expect(
      unguarded.map((f) => path.relative(WEB, f).split(path.sep).join("/")),
      "these copy to the clipboard and never handle it being refused, so the failure is silent"
    ).toEqual([]);
  });

  it("still has a copy to guard", () => {
    // A guard whose subject has been renamed away passes for the wrong reason.
    const copiers = files.filter((f) => readFileSync(f, "utf8").includes("clipboard.writeText"));
    expect(copiers.length, "nothing copies any more — drop this guard").toBeGreaterThan(0);
  });
});
