import { historicalUnsoldStock } from "../inventory/historical-dead-stock";
import { overstockExcess } from "@wezesha/forecast";
const DAY = 86400000;
export function inventoryWeekStart(date: Date): Date {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d;
}
type Product = {
    id: string;
    title: string;
    sku: string;
    costKes: number;
    firstSale: Date | null;
};
export type InventoryPeriodDetail = {
    productId: string;
    title: string;
    sku: string;
    kind: "ordered" | "above recommendation" | "dead stock" | "unsold" | "overstock";
    units: number;
    valueKes: number | null;
};
export type InventoryPeriod = {
    week: string;
    from: string;
    through: string;
    days: number;
    snapshotDays: number;
    endObservedProducts: number;
    eligibleProducts: number;
    orderedUnits: number;
    orderedValueKes: number | null;
    overorderUnits: number | null;
    overorderValueKes: number | null;
    comparisonLines: number;
    unmeasuredLines: number;
    deadCount: number | null;
    unsoldCount: number | null;
    unsoldValueKes: number | null;
    deadValueKes: number | null;
    overstockCount: number | null;
    overstockValueKes: number | null;
    details: InventoryPeriodDetail[];
};
/** Historical period-end holdings and placed PO facts, never today's on-hand. */
export function periodInventory(input: {
    start: Date;
    endExclusive: Date;
    deadWindowDays: number;
    thresholdDays: number;
    canViewCosts: boolean;
    products: Product[];
    sales: {
        productId: string;
        date: Date;
        quantity: number;
    }[];
    snapshots: {
        productId: string;
        date: Date;
        onHand: number;
    }[];
    orders: {
        productId: string;
        date: Date;
        quantity: number;
        recommendedQty: number | null;
        unitCostKes: number;
        lineTotalKes: number;
    }[];
}): InventoryPeriod[] {
    const products = new Map(input.products.map(p => [p.id, p]));
    const result: InventoryPeriod[] = [];
    for (let week = inventoryWeekStart(input.start); week < input.endExclusive; week = new Date(+week + 7 * DAY)) {
        const from = new Date(Math.max(+week, +input.start));
        const end = new Date(Math.min(+week + 7 * DAY, +input.endExclusive));
        const days = (+end - +from) / DAY;
        const latest = new Map<string, {
            date: Date;
            onHand: number;
        }>();
        const observed = new Set<string>();
        for (const s of input.snapshots) {
            if (!products.has(s.productId) || s.date < from || s.date >= end)
                continue;
            observed.add(s.date.toISOString().slice(0, 10));
            if (!latest.has(s.productId) || latest.get(s.productId)!.date < s.date)
                latest.set(s.productId, s);
        }
        const sales = new Map<string, number>();
        const recent = new Set<string>();
        const quietStart = new Date(+end - input.deadWindowDays * DAY);
        for (const s of input.sales) {
            if (s.date >= from && s.date < end)
                sales.set(s.productId, (sales.get(s.productId) ?? 0) + s.quantity);
            if (s.quantity > 0 && s.date >= quietStart && s.date < end)
                recent.add(s.productId);
        }
        const details: InventoryPeriodDetail[] = [];
        const add = (product: Product, kind: InventoryPeriodDetail["kind"], units: number, value: number) => details.push({ productId: product.id, title: product.title, sku: product.sku, kind, units, valueKes: input.canViewCosts ? value : null });
        let unsoldCount = 0, unsoldValue = 0;
        let orderedUnits = 0, orderedValue = 0, overorderUnits = 0, overorderValue = 0, deadValue = 0, overstockValue = 0, deadCount = 0, overstockCount = 0, comparisonLines = 0, unmeasuredLines = 0;
        for (const o of input.orders) {
            const p = products.get(o.productId);
            if (!p || o.date < from || o.date >= end)
                continue;
            orderedUnits += o.quantity;
            orderedValue += o.lineTotalKes;
            add(p, "ordered", o.quantity, o.lineTotalKes);
            if (o.recommendedQty == null)
                unmeasuredLines++;
            else
                comparisonLines++;
            if (o.recommendedQty != null && o.quantity > o.recommendedQty) {
                const units = o.quantity - o.recommendedQty, value = units * o.unitCostKes;
                overorderUnits += units;
                overorderValue += value;
                add(p, "above recommendation", units, value);
            }
        }
        for (const [id, s] of latest) {
            const p = products.get(id)!;
            // Missing end-of-period observations cannot establish period-end stock.
            if (+s.date !== +end - DAY)
                continue;
            if (historicalUnsoldStock(s.onHand, p.firstSale, s.date)) {
                unsoldCount++; unsoldValue += s.onHand * p.costKes;
                add(p, "unsold", s.onHand, s.onHand * p.costKes);
            }
            if (s.onHand > 0 && p.firstSale && p.firstSale < end && !recent.has(id)) {
                deadCount++;
                deadValue += s.onHand * p.costKes;
                add(p, "dead stock", s.onHand, s.onHand * p.costKes);
            }
            const excess = overstockExcess({ currentStock: s.onHand, dailyRate: (sales.get(id) ?? 0) / days, costKes: p.costKes, thresholdDays: input.thresholdDays });
            if (excess.isOverstock) {
                overstockCount++;
                overstockValue += excess.excessValueKes;
                add(p, "overstock", excess.excessUnits, excess.excessValueKes);
            }
        }
        const endObservedProducts = [...latest.values()].filter(s => +s.date === +end - DAY).length;
        const endObserved = endObservedProducts > 0;
        result.push({ week: week.toISOString().slice(0, 10), from: from.toISOString().slice(0, 10), through: new Date(+end - DAY).toISOString().slice(0, 10), days, snapshotDays: observed.size, endObservedProducts, eligibleProducts: products.size, orderedUnits, orderedValueKes: input.canViewCosts ? orderedValue : null, overorderUnits: comparisonLines ? overorderUnits : null, overorderValueKes: comparisonLines && input.canViewCosts ? overorderValue : null, comparisonLines, unmeasuredLines, deadCount: endObserved ? deadCount : null, unsoldCount: endObserved ? unsoldCount : null, unsoldValueKes: endObserved && input.canViewCosts ? unsoldValue : null, deadValueKes: endObserved && input.canViewCosts ? deadValue : null, overstockCount: endObserved ? overstockCount : null, overstockValueKes: endObserved && input.canViewCosts ? overstockValue : null, details });
    }
    return result.reverse();
}
