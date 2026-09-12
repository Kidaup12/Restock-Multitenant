import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Two different daily rates, two different names.
 *
 * The catalogue, product detail, transfers and Today show what the shelf
 * actually did: the measured, stockout-corrected run rate. The buy list and the
 * budget planner show the rate the order was SIZED from — the forecast divided
 * by thirty, which the ABC class floor can set on a line whose shelf has been
 * empty.
 *
 * Both were headed "Run/day" on some screens and "Sells/day" on others, with no
 * relation between the header and which number was underneath. A shop owner
 * looking at one product read 0.09 on the catalogue and 0.4 on the planner and
 * concluded the system was making numbers up. They were two honest answers to
 * two different questions, wearing each other's labels.
 *
 * "Run/day" is retired because it named both. This test keeps it retired.
 */

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", ".next", "tests", "public"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return SKIP_DIRS.has(entry) ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry) ? [full] : [];
  });
}

const rel = (f: string) => path.relative(webRoot, f).split(path.sep).join("/");

describe("one name per rate", () => {
  const files = sourceFiles(path.join(webRoot, "app"));

  it("never labels a column Run/day again — it named both numbers", () => {
    const offenders = files.filter((f) => readFileSync(f, "utf8").includes("Run/day"));
    expect(offenders.map(rel)).toEqual([]);
  });

  it("the buy list and the budget planner call their rate Buying at/day", () => {
    // These two size an order from the forecast rate. If either drifts back to
    // the catalogue's wording, one product shows two numbers under one name.
    for (const page of ["app/(shell)/plan/buy-checklist.tsx", "app/(shell)/plan/budget-planner.tsx"]) {
      const src = readFileSync(path.join(webRoot, page), "utf8");
      expect(src, page).toContain("Buying at/day");
      expect(src, page).not.toContain(">Sells/day<");
    }
  });

  it("the screens showing the measured rate call it Sells/day", () => {
    for (const page of [
      "app/(shell)/products/catalogue-view.tsx",
      "app/(shell)/today/product-tabs.tsx",
      "app/(shell)/transfers/proposal-view.tsx",
    ]) {
      const src = readFileSync(path.join(webRoot, page), "utf8");
      expect(src, page).toContain("Sells/day");
      expect(src, page).not.toContain("Buying at/day");
    }
  });
});
