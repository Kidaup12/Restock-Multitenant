import { prismaForTenant } from "@wezesha/db";

/**
 * The Recommendations tab's data: what to do about stock that isn't selling.
 * Rows are written nightly by the worker (apps/worker/src/recommendations-cron.ts)
 * from the rules in @wezesha/forecast recommendations.ts; this only reads the
 * open ones for the signed-in workspace.
 *
 * Cost-blind for members without view_costs: the cash figure (cost × units) is
 * withheld, and rows rank by idle units instead.
 */

import type { RecommendationAction } from "@/lib/recommendations/labels";
export type { RecommendationAction } from "@/lib/recommendations/labels";

export type RecommendationRow = {
  id: string;
  productId: string;
  action: RecommendationAction;
  title: string;
  sku: string | null;
  supplierName: string | null;
  abc: string | null;
  category: string | null;
  onHand: number;
  idleUnits: number;
  /** Null for a member who can't see costs. */
  cashKes: number | null;
  /** Claude's wording when there is one, otherwise the rule's sentence. */
  reason: string;
  idea: string | null;
  aiWorded: boolean;
  payload: Record<string, string | number | null>;
  firstSeenAt: Date;
};

export type RecommendationList = {
  rows: RecommendationRow[];
  counts: Record<RecommendationAction, number>;
  /** Null for a member who can't see costs. */
  totalCashKes: number | null;
  lastRunAt: Date | null;
};

const ACTIONS: RecommendationAction[] = ["discount", "bundle", "stop_reorder", "clear"];
const isAction = (a: string): a is RecommendationAction => (ACTIONS as string[]).includes(a);

export async function getRecommendations(
  tenantId: string,
  { canViewCosts }: { canViewCosts: boolean }
): Promise<RecommendationList> {
  const db = prismaForTenant(tenantId);
  const [open, latest] = await Promise.all([
    db.stockRecommendation.findMany({
      where: { status: "open" },
      orderBy: canViewCosts ? [{ cashKes: "desc" }, { idleUnits: "desc" }] : [{ idleUnits: "desc" }],
      select: {
        id: true,
        productId: true,
        action: true,
        reason: true,
        aiReason: true,
        aiIdea: true,
        cashKes: true,
        idleUnits: true,
        payload: true,
        firstSeenAt: true,
        product: {
          select: { title: true, sku: true, abcCategory: true, customCategory: true, currentStock: true, supplier: { select: { name: true } } },
        },
      },
    }),
    db.stockRecommendation.findFirst({ orderBy: { updatedAt: "desc" }, select: { updatedAt: true } }),
  ]);

  const counts: Record<RecommendationAction, number> = { discount: 0, bundle: 0, stop_reorder: 0, clear: 0 };
  const rows: RecommendationRow[] = [];
  let total = 0;
  for (const r of open) {
    if (!isAction(r.action)) continue;
    counts[r.action] += 1;
    // A skipped reorder is cash not spent, not cash freed — keep it out of the
    // "tied up" total so the headline isn't double-counted.
    if (r.action !== "stop_reorder") total += r.cashKes;
    rows.push({
      id: r.id,
      productId: r.productId,
      action: r.action,
      title: r.product.title,
      sku: r.product.sku || null,
      supplierName: r.product.supplier?.name ?? null,
      abc: r.product.abcCategory,
      category: r.product.customCategory,
      onHand: r.product.currentStock,
      idleUnits: r.idleUnits,
      cashKes: canViewCosts ? r.cashKes : null,
      reason: r.aiReason ?? r.reason,
      idea: r.aiIdea,
      aiWorded: r.aiReason != null,
      payload: (r.payload ?? {}) as Record<string, string | number | null>,
      firstSeenAt: r.firstSeenAt,
    });
  }
  return { rows, counts, totalCashKes: canViewCosts ? total : null, lastRunAt: latest?.updatedAt ?? null };
}
