"use server";

import { revalidatePath } from "next/cache";
import { prismaForTenant } from "@wezesha/db";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { UnknownProductError, upsertPlanOverride } from "@/lib/data/plan";
import { declarePromo } from "../settings/signals/actions";

/**
 * What a person can do with a recommendation. Tenant and actor come from the
 * session, never the client; every write goes through prismaForTenant, so a
 * recommendation id from another workspace matches nothing.
 */

export type RecommendationActionResult = { ok: true } | { ok: false; error: string };

const DAY_MS = 86_400_000;
/** A dismissed recommendation stays quiet this long before it may come back. */
const DISMISS_DAYS = 90;
/** A done one gets this long to work before the rules look at it again. */
const DONE_DAYS = 30;
/** How long a planned offer runs. */
const OFFER_DAYS = 14;

async function context(permission: "approve_orders" | "manage_settings") {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) return { ok: false as const, error: "You're not in a workspace." };
  if (!hasPermission(membership, permission)) {
    return {
      ok: false as const,
      error: permission === "approve_orders" ? "You don't have ordering access." : "You don't have settings access.",
    };
  }
  return { ok: true as const, session, membership };
}

async function close(tenantId: string, id: string, status: "done" | "dismissed") {
  const days = status === "dismissed" ? DISMISS_DAYS : DONE_DAYS;
  const updated = await prismaForTenant(tenantId).stockRecommendation.updateMany({
    where: { id, status: "open" },
    data: { status, resolvedAt: new Date(), snoozedUntil: new Date(Date.now() + days * DAY_MS) },
  });
  return updated.count > 0;
}

/** Mark done (handled outside the app) or dismiss (not useful). */
export async function closeRecommendation(input: { id: string; outcome: "done" | "dismissed" }): Promise<RecommendationActionResult> {
  const ctx = await context("approve_orders");
  if (!ctx.ok) return ctx;
  if (input.outcome !== "done" && input.outcome !== "dismissed") return { ok: false, error: "Pick done or dismiss." };
  const closed = await close(ctx.membership.tenantId, String(input.id ?? ""), input.outcome);
  if (!closed) return { ok: false, error: "That recommendation is no longer open." };
  revalidatePath("/recommendations");
  return { ok: true };
}

/** Take the product off the buy list (a standing 0 on the plan), then close. */
export async function skipReorder(input: { id: string }): Promise<RecommendationActionResult> {
  const ctx = await context("approve_orders");
  if (!ctx.ok) return ctx;
  const tenantId = ctx.membership.tenantId;
  const rec = await prismaForTenant(tenantId).stockRecommendation.findFirst({
    where: { id: String(input.id ?? ""), status: "open", action: "stop_reorder" },
    select: { id: true, productId: true },
  });
  if (!rec) return { ok: false, error: "That recommendation is no longer open." };
  try {
    await upsertPlanOverride(tenantId, {
      productId: rec.productId,
      qty: 0,
      createdByUserId: ctx.session.user.id,
      createdByName: ctx.membership.displayName ?? null,
    });
  } catch (e) {
    if (e instanceof UnknownProductError) return { ok: false, error: "That product isn't in this workspace." };
    throw e;
  }
  await close(tenantId, rec.id, "done");
  revalidatePath("/recommendations");
  revalidatePath("/plan");
  return { ok: true };
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Record the suggested discount as a promotion for the next two weeks, so the
 * forecast knows the sales bump is a promo and doesn't order to it. Uses the
 * same action as Settings → Signals.
 */
export async function planOffer(input: { id: string }): Promise<RecommendationActionResult> {
  const ctx = await context("manage_settings");
  if (!ctx.ok) return ctx;
  const tenantId = ctx.membership.tenantId;
  const rec = await prismaForTenant(tenantId).stockRecommendation.findFirst({
    where: { id: String(input.id ?? ""), status: "open", action: "discount" },
    select: { id: true, payload: true, product: { select: { sku: true } } },
  });
  if (!rec) return { ok: false, error: "That recommendation is no longer open." };
  if (!rec.product.sku) return { ok: false, error: "Give this product a SKU in Shopify first, so the offer can be matched to it." };
  const pct = Number((rec.payload as { pct?: number } | null)?.pct ?? 0);
  const start = new Date();
  const result = await declarePromo({
    startDate: dayKey(start),
    endDate: dayKey(new Date(start.getTime() + (OFFER_DAYS - 1) * DAY_MS)),
    scope: "sku",
    scopeValue: rec.product.sku,
    promoType: "discount",
    discountPct: String(pct),
    notes: "Planned from Recommendations",
  });
  if (!result.ok) return { ok: false, error: result.error };
  await close(tenantId, rec.id, "done");
  revalidatePath("/recommendations");
  return { ok: true };
}
