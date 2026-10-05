import { describe, expect, it } from "vitest";
import { positionRow, positionWindow, selectPositionRows } from "../lib/inventory/position";
import { positionColumns } from "../app/(shell)/inventory/position/position-export";

const base = { productId: "p1", title: "Serum", sku: "SER", abc: "A", supplier: "Supplier",
  onHand: 12, inbound: 20, windowDays: 30 as const, soldUnits: 60, saleDays: 15,
  observedDays: 30, inStockDays: 20, stockoutDays: 10, openingSnapshot: null };

describe("original-style inventory position", () => {
  it("excludes confirmed empty days and keeps snapshot gaps in the denominator", () => {
    const full = positionRow(base);
    const partial = positionRow({ ...base, observedDays: 12, inStockDays: 2 });
    expect(full.salesPerDay).toBe(3);
    expect(full.coverDays).toBe(4);
    expect(partial.salesPerDay).toBe(3);
    expect(partial.inStockDays).toBe(2);
    expect(partial.observedDays).toBe(12);
  });
  it("trusts a consistent short window, protecting one-off sales with a larger floor", () => {
    const short = { ...base, soldUnits: 12, stockoutDays: 28, inStockDays: 2, saleDays: 2 };
    expect(positionRow(short).effectiveDays).toBe(3);
    expect(positionRow(short).salesPerDay).toBe(4);
    expect(positionRow({ ...short, saleDays: 1 }).effectiveDays).toBe(7);
  });
  it("identifies measured and estimated opening stock rather than implying reconciliation", () => {
    const estimated = positionRow(base);
    expect(estimated.opening).toBe(72);
    expect(estimated.openingEstimated).toBe(true);
    const measured = positionRow({ ...base, openingSnapshot: { onHand: 40, date: "2026-09-06" } });
    expect(measured.opening).toBe(40);
    expect(measured.openingEstimated).toBe(false);
    expect(measured.openingDate).toBe("2026-09-06");
  });
  it("shows no cover for zero demand and zero remaining cover for oversold stock", () => {
    expect(positionRow({ ...base, soldUnits: 0 }).coverDays).toBeNull();
    expect(positionRow({ ...base, onHand: -2 }).coverDays).toBe(0);
  });
  it("keeps unrated separate from C and searches the full report before paging", () => {
    const a = positionRow(base);
    const c = positionRow({ ...base, productId: "c", abc: "C", soldUnits: 100 });
    const unrated = positionRow({ ...base, productId: "u", abc: null, soldUnits: 200 });
    expect(selectPositionRows([unrated, c, a], "ser supplier").map(r => r.productId)).toEqual(["p1", "c", "u"]);
    expect(selectPositionRows([a], "missing")).toEqual([]);
  });
  it("accepts only supported windows and exports the same arithmetic with evidence", () => {
    expect(positionWindow("60")).toBe(60);
    expect(positionWindow(["90"])).toBe(90);
    expect(positionWindow("999999")).toBe(30);
    const row = positionRow(base);
    const exported = Object.fromEntries(positionColumns.map(c => [c.header, c.cell(row)]));
    expect(exported["Adjusted sales/day"]).toBe(3);
    expect(exported["Rate denominator days"]).toBe(20);
    expect(exported["Opening basis"]).toContain("Estimated");
    expect(Object.keys(exported).some(key => /cost|value/i.test(key))).toBe(false);
  });
});
