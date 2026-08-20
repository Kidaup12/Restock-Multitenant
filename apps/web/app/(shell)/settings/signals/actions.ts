"use server";

import { revalidatePath } from "next/cache";
import { boundedMultiplier, SEASONAL_MAX, SEASONAL_MIN } from "@wezesha/forecast";
import { prismaForTenant, prismaService } from "@wezesha/db";
import { dayMarker } from "@wezesha/pos";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { recordClosure, removeClosure } from "@/lib/signals/closures";
import { dayKeysInRange, MAX_CLOSURE_DAYS, MAX_PROMO_DAYS } from "@/lib/signals/dates";
import { SPIKE_IGNORE_KIND, spikeKey } from "@/lib/signals/spikes";

/**
 * Declaring the out-of-the-ordinary: a promotion the shop ran, or a day it was
 * shut. Each action re-resolves the caller's membership and re-checks
 * manage_settings server-side — the view's `canManage` only hides controls.
 * Tenant writes go through the RLS-scoped client, so an id from another tenant
 * resolves to nothing; audit rows ride the service client.
 */

export type SignalActionResult = { ok: true; message?: string } | { ok: false; error: string };

const err = (error: string): SignalActionResult => ({ ok: false, error });

const PROMO_SCOPES = ["all", "sku", "brand", "category"] as const;
const PROMO_TYPES = ["discount", "giveaway", "bundle", "flash"] as const;
const CLOSURE_REASONS = ["closed", "holiday", "refit", "stocktake"] as const;

type Ctx = { tenantId: string; actor: { userId: string; name: string } };

async function manageContext(): Promise<{ ok: true; ctx: Ctx } | { ok: false; error: string }> {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) return { ok: false, error: "You're not in a workspace." };
  if (!hasPermission(membership, "manage_settings")) {
    return { ok: false, error: "You don't have settings access." };
  }
  return {
    ok: true,
    ctx: {
      tenantId: membership.tenantId,
      actor: {
        userId: session.user.id,
        name: membership.displayName ?? session.user.name ?? session.user.email,
      },
    },
  };
}

function oneOf<T extends readonly string[]>(list: T, value: string): value is T[number] {
  return (list as readonly string[]).includes(value);
}

export async function declarePromo(input: {
  startDate: string;
  endDate: string;
  scope: string;
  scopeValue?: string;
  promoType: string;
  discountPct?: string;
  notes?: string;
}): Promise<SignalActionResult> {
  const auth = await manageContext();
  if (!auth.ok) return err(auth.error);
  const { tenantId, actor } = auth.ctx;

  const days = dayKeysInRange(input.startDate, input.endDate, MAX_PROMO_DAYS);
  if (days.length === 0) {
    return err("Check the dates — the last day can't be before the first, and a promotion can't run longer than a year.");
  }
  if (!oneOf(PROMO_SCOPES, input.scope)) return err("Pick what the promotion covered.");
  if (!oneOf(PROMO_TYPES, input.promoType)) return err("Pick what kind of promotion it was.");

  const scopeValue = input.scope === "all" ? null : (input.scopeValue ?? "").trim();
  if (input.scope !== "all" && !scopeValue) return err("Pick what the promotion covered.");

  const discountPct = input.discountPct ? Number(input.discountPct) : 0;
  if (!Number.isFinite(discountPct) || discountPct < 0 || discountPct > 95) {
    return err("The discount should be between 0 and 95%.");
  }

  const db = prismaForTenant(tenantId);
  // A promo on a product code the catalogue doesn't carry would silently match
  // nothing, so catch the typo here rather than let it look declared.
  if (input.scope === "sku") {
    const product = await db.product.findFirst({ where: { sku: scopeValue! }, select: { id: true } });
    if (!product) return err("No product in your catalogue has that code.");
  }

  const created = await db.promo.create({
    data: {
      tenantId,
      startDate: dayMarker(days[0]!),
      endDate: dayMarker(days[days.length - 1]!),
      scope: input.scope,
      scopeValue,
      promoType: input.promoType,
      discountPct,
      notes: input.notes?.trim().slice(0, 300) || null,
    },
    select: { id: true },
  });

  await prismaService.auditEvent.create({
    data: {
      tenantId,
      entity: "Promo",
      entityId: created.id,
      action: "promo_declared",
      actorUserId: actor.userId,
      actorName: actor.name,
      meta: {
        from: days[0]!,
        to: days[days.length - 1]!,
        scope: input.scope,
        scopeValue,
        discountPct,
      },
    },
  });

  revalidatePath("/settings/signals");
  return {
    ok: true,
    message: `Saved — those ${days.length} day${days.length === 1 ? "" : "s"} are left out of your normal sales rate.`,
  };
}

export async function removePromo(input: { promoId: string }): Promise<SignalActionResult> {
  const auth = await manageContext();
  if (!auth.ok) return err(auth.error);
  const { tenantId, actor } = auth.ctx;

  // Soft-delete: a forecast run may already have used this window, so the row
  // stays and only drops out of the lists and future runs.
  const updated = await prismaForTenant(tenantId).promo.updateMany({
    where: { id: input.promoId, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  if (updated.count === 0) return err("That promotion is already gone.");

  await prismaService.auditEvent.create({
    data: {
      tenantId,
      entity: "Promo",
      entityId: input.promoId,
      action: "promo_removed",
      actorUserId: actor.userId,
      actorName: actor.name,
      meta: {},
    },
  });

  revalidatePath("/settings/signals");
  return { ok: true, message: "Removed — those days count as normal again on the next forecast." };
}

export async function declareClosure(input: {
  locationId: string;
  startDate: string;
  endDate: string;
  reason: string;
  note?: string;
}): Promise<SignalActionResult> {
  const auth = await manageContext();
  if (!auth.ok) return err(auth.error);
  const { tenantId, actor } = auth.ctx;

  const days = dayKeysInRange(input.startDate, input.endDate, MAX_CLOSURE_DAYS);
  if (days.length === 0) {
    return err(`Check the dates — the last day can't be before the first, and a closure can't run longer than ${MAX_CLOSURE_DAYS} days.`);
  }
  if (!oneOf(CLOSURE_REASONS, input.reason)) return err("Pick why it was shut.");
  if (!input.locationId) return err("Pick which location was shut.");

  const result = await recordClosure(
    tenantId,
    {
      locationId: input.locationId,
      dayKeys: days,
      reason: input.reason,
      note: input.note?.trim().slice(0, 300) || null,
    },
    actor,
    {
      action: "closure_declared",
      meta: { from: days[0]!, to: days[days.length - 1]!, days: days.length, reason: input.reason },
    }
  );
  if (!result.ok) {
    return err(result.reason === "no_location" ? "That location no longer exists." : "Those dates look invalid.");
  }

  // Closures also clear the matching sales-gap alerts on the Sales screen.
  revalidatePath("/settings/signals");
  revalidatePath("/sales");
  return {
    ok: true,
    message: `Saved — ${result.days} closed day${result.days === 1 ? "" : "s"} recorded.`,
  };
}

/**
 * "December is about triple" — seasonality the shop states.
 *
 * Calendar guessing (holidays, paydays) was in the engine and was removed:
 * backtesting showed it hurt without a full season of history to learn from.
 * This is the other kind of knowledge — a fact the owner holds that the sales
 * history cannot yet contain — so the forecast takes it the way it takes a
 * declared promo, bounded and still under the runaway cap.
 *
 * Stored on MonthlyContext, one row per month, so re-stating a month replaces
 * rather than stacks.
 */
export async function declareMonthExpectation(input: {
  month: string;
  multiplier: number;
  note?: string;
}): Promise<SignalActionResult> {
  const auth = await manageContext();
  if (!auth.ok) return err(auth.error);
  const { tenantId, actor } = auth.ctx;

  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month ?? "")) return err("Pick a month.");
  const bounded = boundedMultiplier(input.multiplier);
  if (bounded == null) {
    return err(
      `Enter how busy the month runs against a normal one — between ${SEASONAL_MIN}x and ${SEASONAL_MAX}x.`
    );
  }
  // Said out loud rather than silently clamped: a shop that typed 40 meant
  // something, and quietly storing 4 would be a number nobody chose.
  if (Math.abs(bounded - input.multiplier) > 1e-9) {
    return err(
      `That is outside what we can size for — keep it between ${SEASONAL_MIN}x and ${SEASONAL_MAX}x a normal month. For a single big week, declare a promotion instead.`
    );
  }

  const db = prismaForTenant(tenantId);
  await db.monthlyContext.upsert({
    where: { tenantId_month: { tenantId, month: input.month } },
    create: {
      tenantId,
      month: input.month,
      expectedMultiplier: bounded,
      notes: input.note?.trim().slice(0, 300) || null,
    },
    update: {
      expectedMultiplier: bounded,
      ...(input.note?.trim() ? { notes: input.note.trim().slice(0, 300) } : {}),
    },
  });

  await prismaService.auditEvent.create({
    data: {
      tenantId,
      entity: "MonthlyContext",
      entityId: input.month,
      action: "month_expectation_set",
      actorUserId: actor.userId,
      actorName: actor.name,
      meta: { month: input.month, multiplier: bounded },
    },
  });

  revalidatePath("/settings/signals");
  return {
    ok: true,
    message: `Saved — ${input.month} is sized at ${bounded}x a normal month from the next forecast.`,
  };
}

/** Put a month back to normal. */
export async function clearMonthExpectation(input: {
  month: string;
}): Promise<SignalActionResult> {
  const auth = await manageContext();
  if (!auth.ok) return err(auth.error);
  const { tenantId, actor } = auth.ctx;

  const db = prismaForTenant(tenantId);
  // The row may carry the shop's own notes, so only the stated multiplier is
  // cleared — deleting it would throw away something nobody asked to remove.
  const cleared = await db.monthlyContext.updateMany({
    where: { month: input.month, expectedMultiplier: { not: null } },
    data: { expectedMultiplier: null },
  });
  if (cleared.count === 0) return err("That month is already sized as normal.");

  await prismaService.auditEvent.create({
    data: {
      tenantId,
      entity: "MonthlyContext",
      entityId: input.month,
      action: "month_expectation_cleared",
      actorUserId: actor.userId,
      actorName: actor.name,
      meta: { month: input.month },
    },
  });

  revalidatePath("/settings/signals");
  return { ok: true, message: "Back to normal from the next forecast." };
}

export async function removeClosureDay(input: {
  locationId: string;
  dayKey: string;
}): Promise<SignalActionResult> {
  const auth = await manageContext();
  if (!auth.ok) return err(auth.error);
  const { tenantId, actor } = auth.ctx;

  const result = await removeClosure(tenantId, input, actor);
  if (!result.ok) {
    return err(result.reason === "not_found" ? "That closed day is already gone." : "That day looks invalid.");
  }

  revalidatePath("/settings/signals");
  revalidatePath("/sales");
  return { ok: true, message: "Removed — that day counts as trading again." };
}

/**
 * Answer a "was this a promo?" question.
 *
 * Yes → a one-day promotion scoped to that product, so the engine leaves the day
 * out of its run rate exactly as a hand-declared promo would. The day is
 * identified by productId rather than SKU: the suggestion came from a product
 * row, and a SKU can be blank or reused.
 */
export async function logSpikeAsPromo(input: {
  productId: string;
  dayKey: string;
}): Promise<SignalActionResult> {
  const auth = await manageContext();
  if (!auth.ok) return err(auth.error);
  const { tenantId, actor } = auth.ctx;

  const days = dayKeysInRange(input.dayKey, input.dayKey, MAX_PROMO_DAYS);
  if (days.length !== 1) return err("That date doesn't look right.");

  const db = prismaForTenant(tenantId);
  // Resolve on the tenant client: a product id from another workspace comes
  // back empty rather than being written against this one.
  const product = await db.product.findFirst({
    where: { id: input.productId },
    select: { id: true, sku: true, title: true },
  });
  if (!product) return err("That product is no longer in your catalogue.");
  if (!product.sku) return err("That product has no code, so a promotion can't be scoped to it.");

  const created = await db.promo.create({
    data: {
      tenantId,
      startDate: dayMarker(days[0]!),
      endDate: dayMarker(days[0]!),
      scope: "sku",
      scopeValue: product.sku,
      promoType: "flash",
      discountPct: 0,
      notes: "Logged from an unusual sales day",
    },
    select: { id: true },
  });

  await prismaService.auditEvent.create({
    data: {
      tenantId,
      entity: "Promo",
      entityId: created.id,
      action: "promo_declared",
      actorUserId: actor.userId,
      actorName: actor.name,
      meta: { from: days[0]!, to: days[0]!, scope: "sku", scopeValue: product.sku, source: "spike_suggestion" },
    },
  });

  revalidatePath("/settings/signals");
  return { ok: true, message: `Logged — ${product.title} on that day is out of your normal sales rate.` };
}

/** No → remember the answer, so the same day stops being raised. */
export async function dismissSpike(input: {
  productId: string;
  dayKey: string;
}): Promise<SignalActionResult> {
  const auth = await manageContext();
  if (!auth.ok) return err(auth.error);
  const { tenantId } = auth.ctx;

  const days = dayKeysInRange(input.dayKey, input.dayKey, MAX_PROMO_DAYS);
  if (days.length !== 1) return err("That date doesn't look right.");

  const db = prismaForTenant(tenantId);
  const product = await db.product.findFirst({
    where: { id: input.productId },
    select: { id: true },
  });
  if (!product) return err("That product is no longer in your catalogue.");

  const value = spikeKey(product.id, days[0]!);
  // Idempotent: asking twice is the same answer, not an error.
  await db.ignoreRule.upsert({
    where: { tenantId_kind_value: { tenantId, kind: SPIKE_IGNORE_KIND, value } },
    create: { tenantId, kind: SPIKE_IGNORE_KIND, value },
    update: {},
  });

  revalidatePath("/settings/signals");
  return { ok: true, message: "Noted — we won't ask about that day again." };
}
