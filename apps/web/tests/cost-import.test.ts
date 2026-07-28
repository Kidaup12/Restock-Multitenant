import { describe, expect, it } from "vitest";
import {
  applicableWrites,
  previewCostImport,
  type CostImportPreview,
  type MatchProduct,
} from "@/lib/cost";

/**
 * Cost upload preview → apply — deterministic and pure. Nothing writes; the
 * preview classifies each row (matched / ambiguous / unknown / invalid) and
 * applicableWrites derives the idempotent write plan.
 */

const PRODUCTS: MatchProduct[] = [
  { id: "p1", sku: "CAN-SHE-340", title: "Cantu Shea Butter Leave-In 340g", costSource: "shopify" },
  { id: "p2", sku: "NL-GLY-750", title: "Nice & Lovely Glycerine 750ml", costSource: "manual" },
  { id: "p3", sku: "DUP-1", title: "Dup A", costSource: "shopify" },
  { id: "p4", sku: "DUP-1", title: "Dup B", costSource: "shopify" }, // duplicate SKU
  { id: "p5", sku: "", title: "No Sku Product", costSource: null },
];

function preview(csv: string): CostImportPreview {
  const r = previewCostImport(csv, PRODUCTS);
  if ("error" in r) throw new Error(r.error);
  return r;
}

describe("previewCostImport", () => {
  it("matches by exact SKU", () => {
    const p = preview("sku,cost\nCAN-SHE-340,1100");
    expect(p.rows[0]).toMatchObject({ status: "matched", productId: "p1", costKes: 1100 });
    expect(p.summary.matched).toBe(1);
  });

  it("matches by exact name when SKU is absent", () => {
    const p = preview("name,cost\nNo Sku Product,420");
    expect(p.rows[0]).toMatchObject({ status: "matched", productId: "p5" });
  });

  it("flags a duplicate SKU as ambiguous (never guessed)", () => {
    const p = preview("sku,cost\nDUP-1,500");
    expect(p.rows[0]!.status).toBe("ambiguous");
    expect(p.summary.ambiguous).toBe(1);
  });

  it("reports an unknown SKU", () => {
    const p = preview("sku,cost\nNOPE-999,500");
    expect(p.rows[0]!.status).toBe("unknown");
  });

  it("rejects a zero/blank cost as invalid (zero-as-missing)", () => {
    const p = preview("sku,cost\nCAN-SHE-340,0\nNL-GLY-750,");
    expect(p.rows[0]!.status).toBe("invalid");
    expect(p.rows[1]!.status).toBe("invalid");
    expect(p.summary.invalid).toBe(2);
  });

  it("rejects a negative cost in any notation, and says so", () => {
    const p = preview("sku,cost\nCAN-SHE-340,-50\nCAN-SHE-340,(50)\nCAN-SHE-340,50-\nCAN-SHE-340,KES -50");
    expect(p.summary.invalid).toBe(4);
    for (const r of p.rows) {
      expect(r.status).toBe("invalid");
      expect(r.costKes).toBeNull();
      expect(r.note).toMatch(/is negative — enter what you pay for one unit, as a positive number\./);
    }
    expect(p.rows[0]!.note).toBe(
      'Cost "-50" is negative — enter what you pay for one unit, as a positive number.',
    );
  });

  it("rejects a second decimal point instead of truncating to a believable number", () => {
    const p = preview("sku,cost\nCAN-SHE-340,1.234.50");
    expect(p.rows[0]).toMatchObject({ status: "invalid", costKes: null });
    expect(p.rows[0]!.note).toBe(
      'Cost "1.234.50" has more than one decimal point — write it like 1,234.50.',
    );
  });

  it("rejects comma groups that aren't thousands (European decimal comma)", () => {
    const p = preview("sku,cost\nCAN-SHE-340,\"1.234,50\"\nCAN-SHE-340,\"1250,50\"");
    expect(p.summary.invalid).toBe(2);
    expect(p.rows[1]!.note).toBe(
      'Cost "1250,50" — use a dot for decimals and commas only for thousands, like 1,234.50.',
    );
  });

  it("names blank and zero separately in the invalid note", () => {
    const p = preview("sku,cost\nCAN-SHE-340,\nCAN-SHE-340,0");
    expect(p.rows[0]!.note).toBe("No cost given — add a purchase cost for this row.");
    expect(p.rows[1]!.note).toBe("Cost is zero — enter the real purchase cost.");
  });

  it("keeps accepting plain, thousands-separated, symbol-prefixed and padded costs", () => {
    const p = preview(
      'sku,cost\nCAN-SHE-340,1100\nCAN-SHE-340,"1,234.50"\nCAN-SHE-340,"KES 1,250.50"\nCAN-SHE-340," 900.25 "\nCAN-SHE-340,1234.5',
    );
    expect(p.rows.map((r) => r.costKes)).toEqual([1100, 1234.5, 1250.5, 900.25, 1234.5]);
    expect(p.summary.invalid).toBe(0);
    expect(p.summary.matched).toBe(5);
  });

  it("marks a matched manual-pinned row as pinned (held back by default)", () => {
    const p = preview("sku,cost\nNL-GLY-750,300");
    expect(p.rows[0]).toMatchObject({ status: "matched", productId: "p2", pinned: true });
    expect(p.summary.pinned).toBe(1);
  });

  it("tolerant headers + money formatting (KES, thousands)", () => {
    const p = preview("Item SKU,Purchase Cost\nCAN-SHE-340,\"KES 1,250.50\"");
    expect(p.rows[0]).toMatchObject({ status: "matched", costKes: 1250.5 });
  });

  it("errors without a cost column", () => {
    const r = previewCostImport("sku,foo\nX,1", PRODUCTS);
    expect("error" in r).toBe(true);
  });

  it("errors without a SKU or name column", () => {
    const r = previewCostImport("cost\n100", PRODUCTS);
    expect("error" in r).toBe(true);
  });
});

describe("applicableWrites", () => {
  it("plans matched, non-pinned rows only", () => {
    const p = preview("sku,cost\nCAN-SHE-340,1100\nNL-GLY-750,300\nDUP-1,500\nNOPE,9");
    expect(applicableWrites(p)).toEqual([{ productId: "p1", costKes: 1100 }]);
  });

  it("includes pinned rows only when overwrite is confirmed", () => {
    const p = preview("sku,cost\nNL-GLY-750,300");
    expect(applicableWrites(p)).toEqual([]);
    expect(applicableWrites(p, { overwritePinned: true })).toEqual([{ productId: "p2", costKes: 300 }]);
  });

  it("dedupes by product (first row wins) and is idempotent", () => {
    const p = preview("sku,cost\nCAN-SHE-340,1100\nCAN-SHE-340,1200");
    const first = applicableWrites(p);
    expect(first).toEqual([{ productId: "p1", costKes: 1100 }]);
    // Same preview → same plan.
    expect(applicableWrites(p)).toEqual(first);
  });
});
