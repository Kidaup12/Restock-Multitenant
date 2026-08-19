import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Menus anchored to the bottom of the sidebar rail must open UPWARD, from the
 * left edge.
 *
 * The account menu opened downward and right-aligned. Both are wrong for a
 * control pinned to the bottom-left corner: right-aligning a 256px panel to a
 * 36px avatar at x=12 puts it at x=-208, and opening downward from y=612 in a
 * 656px viewport starts it below the fold. The menu was in the DOM, marked
 * visible, and reachable by every automated check — and no reader could see it.
 * Sign out lived in there, which is how it came to be reported as present.
 *
 * The workspace switcher directly above it always had this right; the two had
 * simply drifted. Guarding the pair together is the point — a single file's
 * class list would not have caught the drift.
 */

const shell = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../components/shell/${file}`, import.meta.url)), "utf8");

const RAIL_MENUS = ["profile-menu.tsx", "workspace-switcher.tsx"];

/** The class list on the element carrying role="menu". */
function menuClasses(source: string): string {
  const at = source.indexOf('role="menu"');
  expect(at, "no role=\"menu\" in this component").toBeGreaterThan(-1);
  const after = source.slice(at, at + 900);
  const match = after.match(/className=(?:\{cn\(\s*)?"([^"]+)"/);
  return match?.[1] ?? "";
}

describe("bottom-anchored rail menus", () => {
  for (const file of RAIL_MENUS) {
    it(`${file} opens upward, not off the bottom of the viewport`, () => {
      expect(menuClasses(shell(file))).toContain("bottom-full");
    });

    it(`${file} aligns to the left edge, not off the side of the rail`, () => {
      const classes = menuClasses(shell(file));
      expect(classes).toContain("left-0");
      expect(classes).not.toContain("right-0");
    });
  }
});
