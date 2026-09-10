import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DaysLeft } from "@/components/ui/days-left";

/**
 * An empty shelf reads as "0d", not as a blank.
 *
 * The buy list printed a dash for every out-of-stock row — the most urgent
 * state the column has, shown as though it were unknown. Three tables carried
 * the same expression and all three were wrong the same way, while the CSV
 * export wrote the number straight out; the file and the screen disagreed about
 * the same row, and the shop spotted it before we did.
 *
 * The second case is deliberately NOT a zero. A null means the product sells
 * too slowly to run out inside the horizon, so "0" would say the opposite of
 * the truth — the two states look alike in the data and mean opposite things.
 */

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("days left", () => {
  it("says 0d when the shelf is empty", () => {
    const out = html(<DaysLeft days={null} onHandUnits={0} />);
    expect(out, "an out-of-stock row rendered a blank instead of 0d").toContain("0d");
    expect(out, "the most urgent state is not marked as urgent").toContain("text-negative");
  });

  it("still says 0d when a stale days figure survives alongside no stock", () => {
    // Stock and the forecast are written by different jobs, so a row can carry
    // a positive days figure with nothing on the shelf. What is on the shelf
    // wins: the buyer is looking at today.
    expect(html(<DaysLeft days={12} onHandUnits={0} />)).toContain("0d");
  });

  it("shows the number when there is stock", () => {
    expect(html(<DaysLeft days={12} onHandUnits={40} />)).toContain("12d");
  });

  it("does not invent a zero for something that will not run out", () => {
    const out = html(<DaysLeft days={null} onHandUnits={40} />);
    expect(out, "a product that cannot run out was reported as out of stock").not.toContain("0d");
    expect(out, "the dash says nothing about why").toContain("too slowly");
  });
});

describe("every table asks the shared component", () => {
  // The bug was three copies of one expression. A fourth copy would not be
  // caught by the cases above, so the shape itself is guarded.
  const APP = path.join(__dirname, "..", "app");

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (e.name.endsWith(".tsx")) out.push(p);
    }
    return out;
  }

  it("nobody renders days-left by hand any more", () => {
    const files = walk(APP);
    expect(files.length, "the walk found nothing").toBeGreaterThan(50);
    const handRolled = files.filter((f) => {
      const src = readFileSync(f, "utf8");
      return /daysUntilStockout\s*==\s*null\s*$|onHandUnits\s*<=\s*0\s*\|\|/m.test(src);
    });
    expect(
      handRolled.map((f) => path.relative(APP, f).split(path.sep).join("/")),
      "these render days-left themselves — use <DaysLeft>, or the copies drift apart again"
    ).toEqual([]);
  });
});
