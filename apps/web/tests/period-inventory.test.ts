import { describe, expect, it } from "vitest";
import { periodInventory } from "../lib/reports/period-inventory";
const start = new Date("2026-09-28"), endExclusive = new Date("2026-10-05");
const products = [{ id: "moving", sku: "M", title: "Moving", costKes: 10, firstSale: new Date("2026-01-01") }, { id: "dead", sku: "D", title: "Dead", costKes: 10, firstSale: new Date("2026-01-01") }, { id: "new", sku: "N", title: "New", costKes: 10, firstSale: null }];
const base = { start, endExclusive, deadWindowDays: 30, thresholdDays: 90, canViewCosts: true, products, sales: [{ productId: "moving", date: new Date("2026-10-01"), quantity: 7 }], snapshots: [{ productId: "moving", date: new Date("2026-10-04"), onHand: 100 }, { productId: "dead", date: new Date("2026-10-04"), onHand: 5 }, { productId: "new", date: new Date("2026-10-04"), onHand: 5 }], orders: [{ productId: "moving", date: new Date("2026-10-01"), quantity: 12, recommendedQty: 8, unitCostKes: 7, lineTotalKes: 84 }, { productId: "dead", date: new Date("2026-10-01"), quantity: 10, recommendedQty: null, unitCostKes: 2, lineTotalKes: 20 }] };
describe("historical purchasing and stock metrics", () => {
    it("compares placed PO lines with their saved recommendation and excludes hand-built lines from overorder", () => {
        const [row] = periodInventory(base);
        expect(row).toMatchObject({ orderedUnits: 22, orderedValueKes: 104, overorderUnits: 4, overorderValueKes: 28 });
        expect(row!.details.filter(d => d.kind === "above recommendation")).toMatchObject([{ productId: "moving", units: 4, valueKes: 28 }]);
    });
    it("uses end snapshot and period sales for overstock, and real prior sales for the quiet-window dead measure", () => {
        const [row] = periodInventory(base);
        expect(row).toMatchObject({ deadCount: 1, deadValueKes: 50, overstockCount: 1, overstockValueKes: 100 });
        expect(row!.details.filter(d => d.kind === "overstock")).toMatchObject([{ productId: "moving", units: 10 }]);
    });
    it("does not call an unobserved period end zero dead stock or reuse a previous day's shelf count", () => {
        const [row] = periodInventory({ ...base, snapshots: base.snapshots.map(s => ({ ...s, date: new Date("2026-10-03") })) });
        expect(row!.deadCount).toBeNull();
        expect(row!.overstockCount).toBeNull();
        expect(row!.orderedUnits).toBe(22);
    });
    it("uses both selected boundaries and the clipped number of days", () => {
        const [row] = periodInventory({ ...base, start: new Date("2026-10-01"), endExclusive: new Date("2026-10-03"), orders: [...base.orders, { ...base.orders[0]!, date: new Date("2026-10-03") }], snapshots: [{ productId: "moving", date: new Date("2026-10-02"), onHand: 100 }] });
        expect(row).toMatchObject({ days: 2, orderedUnits: 22, overstockCount: 0 });
    });
    it("removes every cost value from returned summary and drill rows for money-blind readers", () => {
        const [row] = periodInventory({ ...base, canViewCosts: false });
        for (const key of ["orderedValueKes", "overorderValueKes", "deadValueKes", "overstockValueKes"] as const)
            expect(row![key]).toBeNull();
        expect(row!.details.every(d => d.valueKes === null)).toBe(true);
    });
    it("labels comparisons unavailable when placed lines have no saved recommendation", () => {
        const [row] = periodInventory({ ...base, orders: [base.orders[1]!] });
        expect(row).toMatchObject({ orderedUnits: 10, overorderUnits: null, overorderValueKes: null, comparisonLines: 0, unmeasuredLines: 1 });
    });
});
