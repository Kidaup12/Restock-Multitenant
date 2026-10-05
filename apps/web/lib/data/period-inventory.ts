import { prismaForTenantTx } from "@wezesha/db";
import { matchesAbc, type AbcKey } from "./abc-lens";
import { resolveReportRange, type ReportRange } from "./report-range";
import { periodInventory } from "../reports/period-inventory";
export async function getPeriodInventory(tenantId: string, options: {
    weeks: number;
    abc: AbcKey;
    canViewCosts: boolean;
    period?: ReportRange;
}) {
    return prismaForTenantTx(tenantId, async (tx) => {
        const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
        const timezone = tenant?.timezone ?? "UTC";
        const today = resolveReportRange({ range: "7d" }, timezone);
        const period = options.period ?? resolveReportRange({ from: new Date(+today.endExclusive - Math.min(52, Math.max(1, options.weeks)) * 7 * 86400000).toISOString().slice(0, 10), to: today.to }, timezone);
        const cfg = await tx.tenantConfig.findFirst({ select: { deadStockWindowDays: true } });
        const deadWindowDays = Math.max(30, Math.min(365, cfg?.deadStockWindowDays ?? 90));
        const [products, sales, snapshots, lines, firstSales] = await Promise.all([
            tx.product.findMany({ select: { id: true, title: true, sku: true, abcCategory: true, costKes: true } }),
            tx.salesHistory.findMany({ where: { date: { gte: new Date(+period.start - deadWindowDays * 86400000), lt: period.endExclusive } }, select: { productId: true, date: true, quantity: true } }),
            tx.inventorySnapshot.findMany({ where: { date: { gte: period.start, lt: period.endExclusive } }, select: { productId: true, date: true, onHand: true } }),
            tx.purchaseOrderLine.findMany({ where: { purchaseOrder: { deletedAt: null, status: { notIn: ["draft", "cancelled"] }, OR: [{ sentAt: { gte: period.startInstant, lt: period.endInstant } }, { sentAt: null, createdAt: { gte: period.startInstant, lt: period.endInstant } }] } }, select: { productId: true, quantity: true, recommendedQty: true, unitCostKes: true, lineTotalKes: true, purchaseOrder: { select: { sentAt: true, createdAt: true } } } }),
            tx.salesHistory.groupBy({ by: ["productId"], where: { quantity: { gt: 0 }, date: { lt: period.endExclusive } }, _min: { date: true } }),
        ]);
        const firstById = new Map(firstSales.map(s => [s.productId, s._min.date]));
        const localDay = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
        return { deadWindowDays, rows: periodInventory({ start: period.start, endExclusive: period.endExclusive, deadWindowDays, thresholdDays: 90, canViewCosts: options.canViewCosts, products: products.filter(p => matchesAbc({ abc: p.abcCategory }, options.abc)).map(p => ({ ...p, firstSale: firstById.get(p.id) ?? null })), sales, snapshots, orders: lines.map(l => ({ ...l, date: new Date(`${localDay.format(l.purchaseOrder.sentAt ?? l.purchaseOrder.createdAt)}T00:00:00.000Z`) })) }) };
    }, { maxWait: 30000, timeout: 60000 });
}
