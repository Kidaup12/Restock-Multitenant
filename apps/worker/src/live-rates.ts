import { prismaService } from "@wezesha/db";
import { runRateDaily, type SalesPoint } from "@wezesha/forecast";
import { dayMarker, tenantDayKey } from "@wezesha/pos";

/**
 * The run rate the app's screens show, for a set of products — so the report
 * emails print the number the shop sees on its dashboard, not the planner's
 * sizing rate (finalForecast30d / 30). Upstream #96: "the email should just
 * copy from the system".
 *
 * Same inputs and the same engine call as apps/web lib/metrics/catalogue.ts:
 * 365 days of all-channel sales, the snapshot days the shelf was empty (the
 * in-stock denominator), how far back snapshots reach, the tenant's baseline
 * method and bulk-day damping (default on), and the tenant's trading day.
 * apps/web can't be imported here, so this is the one deliberate mirror.
 */
const HISTORY_DAYS = 365;
const DAY_MS = 86_400_000;

export async function dashboardRunRates(
  tenantId: string,
  productIds: string[],
  asOf: Date = new Date()
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (productIds.length === 0) return out;
  const since = new Date(
    Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()) - (HISTORY_DAYS + 1) * DAY_MS
  );
  const [sales, empty, firstSnapshot, config, tenant] = await Promise.all([
    prismaService.salesHistory.findMany({
      where: { tenantId, productId: { in: productIds }, date: { gte: since } },
      select: { productId: true, date: true, quantity: true, revenueKes: true, channel: true },
    }),
    prismaService.inventorySnapshot.findMany({
      where: { tenantId, productId: { in: productIds }, date: { gte: since }, onHand: { lte: 0 } },
      select: { productId: true, date: true },
    }),
    prismaService.inventorySnapshot.findFirst({ where: { tenantId }, orderBy: { date: "asc" }, select: { date: true } }),
    prismaService.tenantConfig.findFirst({ where: { tenantId }, select: { baselineMethod: true, bigBuyerDamping: true } }),
    // eslint-disable-next-line tenant-safety/require-tenant-scope -- reads the one tenant this job is for, by id.
    prismaService.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } }),
  ]);
  const rateDay = dayMarker(tenantDayKey(tenant?.timezone ?? "Africa/Nairobi", asOf));
  const history = new Map<string, SalesPoint[]>();
  for (const row of sales) {
    let list = history.get(row.productId);
    if (!list) history.set(row.productId, (list = []));
    list.push(row);
  }
  const stockouts = new Map<string, Date[]>();
  for (const row of empty) {
    let list = stockouts.get(row.productId);
    if (!list) stockouts.set(row.productId, (list = []));
    list.push(row.date);
  }
  const method = config?.baselineMethod === "median" ? "median" : "mean";
  for (const id of productIds) {
    out.set(
      id,
      runRateDaily(
        history.get(id) ?? [],
        rateDay,
        stockouts.get(id),
        undefined,
        firstSnapshot?.date ?? undefined,
        method,
        config?.bigBuyerDamping !== false
      )
    );
  }
  return out;
}
