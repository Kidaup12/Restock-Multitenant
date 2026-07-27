"use server";

import { revalidatePath } from "next/cache";
import { prismaForTenant, prismaService } from "@wezesha/db";
import { dayMarker } from "@wezesha/pos";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { recordClosure, removeClosure } from "@/lib/signals/closures";
import { dayKeysInRange, MAX_CLOSURE_DAYS, MAX_PROMO_DAYS } from "@/lib/signals/dates";

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
