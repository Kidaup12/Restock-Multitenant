import { prismaForTenant } from "@wezesha/db";

/**
 * Weekly spot-check queries: this week's SKUs the app asked the shop to
 * physically count, and where a count is in, the drift against what the app
 * believed on hand.
 *
 * The worker cron writes one SpotCheck row per picked SKU each Monday
 * (apps/worker spot-check-cron.ts); this reads them back for the current ISO
 * week. Drift = countedQty − systemQty, so a NEGATIVE number is stock that has
 * gone missing (theft/breakage/un-scanned sales) and a positive one is stock the
 * app under-counted. It exists only once a count is recorded.
 *
 * Server-only: explicit tenantId, RLS-enforced tenant client. SpotCheck has no
 * product relation in the schema, so the product title/sku is fetched in a
 * second scoped query and joined in memory.
 */

const pad = (n: number) => String(n).padStart(2, "0");
const DAY = 86_400_000;

/** ISO-8601 week key ("YYYY-Www"), matching the key the worker cron writes and
 *  Postgres to_char(date, 'IYYY-"W"IW'). */
export function isoWeekKey(d: Date = new Date()): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7; // Mon=1..Sun=7
  t.setUTCDate(t.getUTCDate() + 4 - day); // the Thursday decides the ISO year
  const isoYear = t.getUTCFullYear();
  const jan1 = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((t.getTime() - jan1.getTime()) / DAY + 1) / 7);
  return `${isoYear}-W${pad(week)}`;
}

export type SpotCheckRow = {
  id: string;
  productId: string;
  title: string;
  sku: string;
  systemQty: number;
  countedQty: number | null;
  /** countedQty − systemQty; null until counted. Negative = stock is short. */
  drift: number | null;
  countedAt: Date | null;
};

export type WeeklySpotChecks = {
  weekKey: string;
  rows: SpotCheckRow[];
  /** How many of this week's SKUs still need counting. */
  remaining: number;
};

/**
 * This week's spot-check prompts for a tenant, joined to product title/sku, with
 * drift computed where a count is in. Rows come out uncounted-first (the work
 * still to do), then by title.
 */
export async function getWeeklySpotChecks(
  tenantId: string,
  now: Date = new Date()
): Promise<WeeklySpotChecks> {
  const db = prismaForTenant(tenantId);
  const weekKey = isoWeekKey(now);

  const checks = await db.spotCheck.findMany({
    where: { weekKey },
    select: {
      id: true,
      productId: true,
      systemQty: true,
      countedQty: true,
      countedAt: true,
    },
  });

  if (checks.length === 0) return { weekKey, rows: [], remaining: 0 };

  const products = await db.product.findMany({
    where: { id: { in: checks.map((c) => c.productId) } },
    select: { id: true, title: true, sku: true },
  });
  const metaById = new Map(products.map((p) => [p.id, p]));

  const rows: SpotCheckRow[] = checks.map((c) => {
    const meta = metaById.get(c.productId);
    return {
      id: c.id,
      productId: c.productId,
      title: meta?.title ?? "Unknown product",
      sku: meta?.sku ?? "",
      systemQty: c.systemQty,
      countedQty: c.countedQty,
      drift: c.countedQty == null ? null : c.countedQty - c.systemQty,
      countedAt: c.countedAt,
    };
  });

  rows.sort((a, b) => {
    // Uncounted first — that's the list of what's left to do this week.
    const aDone = a.countedQty != null ? 1 : 0;
    const bDone = b.countedQty != null ? 1 : 0;
    return aDone - bDone || a.title.localeCompare(b.title);
  });

  return {
    weekKey,
    rows,
    remaining: rows.filter((r) => r.countedQty == null).length,
  };
}

/**
 * Record a physical count for one spot-check row. Returns false when the id is
 * not this tenant's (a stale tab or a crafted call), so the caller answers a
 * clean refusal rather than a 500. The tenant client cannot see another
 * workspace's row, so the update simply matches nothing there — this makes that
 * miss explicit and does the write in one round trip.
 */
export async function recordSpotCheckCount(
  tenantId: string,
  spotCheckId: string,
  countedQty: number,
  countedAt: Date = new Date()
): Promise<boolean> {
  const db = prismaForTenant(tenantId);
  const result = await db.spotCheck.updateMany({
    where: { id: spotCheckId },
    data: { countedQty, countedAt },
  });
  return result.count > 0;
}
