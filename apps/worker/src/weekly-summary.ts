import { BUYABLE_PRODUCT_WHERE, prismaService } from "@wezesha/db";

/**
 * Weekly tenant summary: the numbers an owner wants in Monday's inbox.
 *
 * Queries run on prismaService WITH an explicit tenantId filter on every
 * where-clause — the cron fires with no session and no request, so there is no
 * tenant context to scope a client with; that system path is the documented
 * use of the BYPASSRLS connection.
 */

const DAY_MS = 86_400_000;

export interface WeeklySummary {
  tenantName: string;
  revenue30dKes: number;
  unitsSold30d: number;
  stockouts: number;
  topMovers: Array<{ title: string; units: number }>;
}

export async function buildWeeklySummary(tenantId: string): Promise<WeeklySummary | null> {
  // eslint-disable-next-line tenant-safety/require-tenant-scope -- reads one tenant by the id the job already carries; the worker has no session, so there is no resolver to route through.
  const tenant = await prismaService.tenant.findUnique({
    where: { id: tenantId },
    select: { name: true },
  });
  if (!tenant) return null;

  const since = new Date(Date.now() - 30 * DAY_MS);
  const [totals, products, movers] = await Promise.all([
    prismaService.salesHistory.aggregate({
      _sum: { revenueKes: true, quantity: true },
      where: { tenantId, date: { gte: since } },
    }),
    prismaService.product.findMany({
      where: { tenantId, ...BUYABLE_PRODUCT_WHERE },
      select: { currentStock: true },
    }),
    prismaService.salesHistory.groupBy({
      by: ["productId"],
      where: { tenantId, date: { gte: since } },
      _sum: { quantity: true },
      orderBy: { _sum: { quantity: "desc" } },
      take: 5,
    }),
  ]);

  // Stocked out reads the same sellable rollup the app does (Product.currentStock),
  // not a sum across all locations — a warehouse hold is not stock on the shelf.
  const stockouts = products.filter((p) => p.currentStock <= 0).length;

  const moverTitles = await prismaService.product.findMany({
    where: { tenantId, id: { in: movers.map((m) => m.productId) } },
    select: { id: true, title: true },
  });
  const titleById = new Map(moverTitles.map((p) => [p.id, p.title]));

  return {
    tenantName: tenant.name,
    revenue30dKes: totals._sum.revenueKes ?? 0,
    unitsSold30d: totals._sum.quantity ?? 0,
    stockouts,
    topMovers: movers.map((m) => ({
      title: titleById.get(m.productId) ?? "Unknown product",
      units: m._sum.quantity ?? 0,
    })),
  };
}

/** Plain-text body for the summary email. */
export function renderWeeklySummary(summary: WeeklySummary): string {
  const lines = [
    `Weekly stock summary — ${summary.tenantName}`,
    "",
    `Revenue, last 30 days: KES ${Math.round(summary.revenue30dKes).toLocaleString("en-KE")}`,
    `Units sold, last 30 days: ${Math.round(summary.unitsSold30d).toLocaleString("en-KE")}`,
    `Products stocked out right now: ${summary.stockouts}`,
    "",
    "Top movers (units, last 30 days):",
  ];
  if (summary.topMovers.length === 0) {
    lines.push("  (no sales recorded)");
  } else {
    for (const mover of summary.topMovers) {
      lines.push(`  ${Math.round(mover.units).toLocaleString("en-KE")} × ${mover.title}`);
    }
  }
  lines.push("", "Open Wezesha Restock for the full picture and this week's buy list.");
  return lines.join("\n");
}
