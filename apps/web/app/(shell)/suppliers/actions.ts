"use server";

import { revalidatePath } from "next/cache";
import { Prisma, prismaForTenant, prismaForTenantTx, prismaService } from "@wezesha/db";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { learnedLeadMedianDays } from "@/lib/suppliers/lead-time";

/**
 * Suppliers actions. Every action re-resolves the caller's membership and
 * re-checks manage_settings server-side; the tenant id comes from the
 * membership, never the client. Writes run on the RLS-scoped tenant client (a
 * foreign id resolves to nothing), and the audit row rides the service client so
 * no tenant role can filter it.
 */

export type SupplierActionResult =
  | { ok: true; message?: string }
  | { ok: false; error: string };

const err = (error: string): SupplierActionResult => ({ ok: false, error });

const CURRENCIES = ["KES", "USD", "CNY", "AED"] as const;

async function actorContext() {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) return null;
  if (!hasPermission(membership, "manage_settings")) return null;
  return {
    tenantId: membership.tenantId,
    actor: {
      userId: session.user.id,
      name: membership.displayName ?? session.user.name ?? session.user.email,
    },
  };
}

export type SupplierInput = {
  name: string;
  email?: string | null;
  country?: string | null;
  currency?: string | null;
  supplierGroup?: string | null;
  leadTimeAvgDays?: number | null;
  leadTimeStdDays?: number | null;
  moq?: number | null;
};

/** Normalise + validate a create/edit payload into Prisma data, or an error. */
function parseSupplier(input: SupplierInput):
  | { ok: true; data: {
      name: string;
      email: string | null;
      country: string | null;
      currency: string;
      supplierGroup: string | null;
      leadTimeAvgDays: number | null;
      leadTimeStdDays: number;
      moq: number;
    } }
  | { ok: false; error: string } {
  const name = input.name?.trim();
  if (!name) return { ok: false, error: "Give the supplier a name." };

  const currency = (input.currency ?? "USD").trim().toUpperCase();
  if (!(CURRENCIES as readonly string[]).includes(currency)) {
    return { ok: false, error: "Currency must be one of KES, USD, CNY or AED." };
  }

  const lead = normInt(input.leadTimeAvgDays);
  if (lead != null && (lead < 0 || lead > 365)) {
    return { ok: false, error: "Lead time should be between 0 and 365 days." };
  }
  const std = normInt(input.leadTimeStdDays) ?? 7;
  if (std < 0 || std > 180) {
    return { ok: false, error: "Lead-time variability should be between 0 and 180 days." };
  }
  const moq = normInt(input.moq) ?? 1;
  if (moq < 1) return { ok: false, error: "Minimum order quantity must be at least 1." };

  return {
    ok: true,
    data: {
      name,
      email: emptyToNull(input.email),
      country: emptyToNull(input.country),
      currency,
      supplierGroup: emptyToNull(input.supplierGroup),
      leadTimeAvgDays: lead,
      leadTimeStdDays: std,
      moq,
    },
  };
}

function normInt(value: number | null | undefined): number | null {
  if (value == null || Number.isNaN(value)) return null;
  return Math.round(value);
}

function emptyToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export async function createSupplierAction(
  input: SupplierInput & { productIds?: string[] }
): Promise<SupplierActionResult> {
  const ctx = await actorContext();
  if (!ctx) return err("You don't have settings access in this workspace.");
  const parsed = parseSupplier(input);
  if (!parsed.ok) return err(parsed.error);

  const ids = [...new Set((input.productIds ?? []).filter((id) => typeof id === "string" && id))];
  if (ids.length > ASSIGN_MAX) return err(`Assign up to ${ASSIGN_MAX} products at a time.`);

  // Create and assign in ONE transaction. Two calls from the browser could
  // half-apply — a supplier saved with none of the products the owner picked,
  // which reads as the assignment silently failing.
  const { supplier, assigned } = await prismaForTenantTx(ctx.tenantId, async (tx) => {
    const created = await tx.supplier.create({ data: { tenantId: ctx.tenantId, ...parsed.data } });
    if (ids.length === 0) return { supplier: created, assigned: 0 };
    // Resolved on the tenant client: an id from another workspace comes back
    // empty rather than being reassigned into this one.
    const found = await tx.product.findMany({ where: { id: { in: ids } }, select: { id: true } });
    if (found.length === 0) return { supplier: created, assigned: 0 };
    const result = await tx.product.updateMany({
      where: { id: { in: found.map((p) => p.id) } },
      data: { supplierId: created.id },
    });
    return { supplier: created, assigned: result.count };
  });

  await audit(ctx.tenantId, supplier.id, "created", ctx.actor, { name: supplier.name, products: assigned });
  revalidatePath("/suppliers");
  if (assigned > 0) revalidatePath("/stock");
  return {
    ok: true,
    message:
      assigned > 0
        ? `Added ${supplier.name} with ${assigned} product${assigned === 1 ? "" : "s"}.`
        : `Added ${supplier.name}.`,
  };
}

export async function updateSupplierAction(
  input: SupplierInput & { supplierId: string },
): Promise<SupplierActionResult> {
  const ctx = await actorContext();
  if (!ctx) return err("You don't have settings access in this workspace.");
  const parsed = parseSupplier(input);
  if (!parsed.ok) return err(parsed.error);

  const db = prismaForTenant(ctx.tenantId);
  const existing = await db.supplier.findFirst({
    where: { id: input.supplierId, deletedAt: null },
    select: { id: true },
  });
  if (!existing) return err("That supplier no longer exists.");

  await db.supplier.update({ where: { id: existing.id }, data: parsed.data });
  await audit(ctx.tenantId, existing.id, "edited", ctx.actor, { name: parsed.data.name });
  revalidatePath("/suppliers");
  return { ok: true, message: `Saved ${parsed.data.name}.` };
}

/**
 * Adopt the learned median lead time as the supplier's typed value. Recomputes
 * the median server-side from receipt history (never trusts a client-sent
 * number), so the write is exactly what the page showed.
 */
export async function adoptLearnedLeadAction(input: {
  supplierId: string;
}): Promise<SupplierActionResult> {
  const ctx = await actorContext();
  if (!ctx) return err("You don't have settings access in this workspace.");

  const db = prismaForTenant(ctx.tenantId);
  const supplier = await db.supplier.findFirst({
    where: { id: input.supplierId, deletedAt: null },
    select: { id: true, name: true, leadTimeAvgDays: true },
  });
  if (!supplier) return err("That supplier no longer exists.");

  const pos = await db.purchaseOrder.findMany({
    where: {
      supplierId: supplier.id,
      deletedAt: null,
      sentAt: { not: null },
      receivedAt: { not: null },
    },
    select: { sentAt: true, receivedAt: true },
  });
  const learned = learnedLeadMedianDays(
    pos.map((p) => ({ sentAt: p.sentAt!, receivedAt: p.receivedAt! })),
  );
  if (learned == null) return err("Not enough deliveries yet to learn a lead time.");

  await db.supplier.update({ where: { id: supplier.id }, data: { leadTimeAvgDays: learned } });
  await audit(ctx.tenantId, supplier.id, "edited", ctx.actor, {
    field: "leadTimeAvgDays",
    from: supplier.leadTimeAvgDays,
    to: learned,
    source: "learned",
  });
  revalidatePath("/suppliers");
  return { ok: true, message: `${supplier.name} lead time set to ${learned} days.` };
}

/**
 * Assign every unassigned product of one brand (Shopify vendor) to a supplier in
 * a single write. The supplier is resolved on the tenant client so a foreign id
 * is invisible; only products still without a supplier are touched.
 */
export async function bulkAssignByBrandAction(input: {
  vendor: string;
  supplierId: string;
}): Promise<SupplierActionResult> {
  const ctx = await actorContext();
  if (!ctx) return err("You don't have settings access in this workspace.");
  const vendor = input.vendor?.trim();
  if (!vendor) return err("Pick a brand to assign.");

  const db = prismaForTenant(ctx.tenantId);
  const supplier = await db.supplier.findFirst({
    where: { id: input.supplierId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!supplier) return err("Pick a supplier that still exists.");

  const result = await db.product.updateMany({
    where: { vendor, supplierId: null },
    data: { supplierId: supplier.id },
  });
  if (result.count === 0) return err("Those products already have a supplier.");

  await audit(ctx.tenantId, supplier.id, "edited", ctx.actor, {
    action: "bulk_assign_by_brand",
    vendor,
    supplierName: supplier.name,
    products: result.count,
  });
  revalidatePath("/suppliers");
  return { ok: true, message: `Assigned ${result.count} ${vendor} products to ${supplier.name}.` };
}

/** How many products one call may move. Generous enough for "assign this whole
 *  brand", small enough that a malformed payload cannot rewrite the catalogue. */
const ASSIGN_MAX = 500;

/**
 * Put a chosen set of products under one supplier.
 *
 * The counterpart to assigning by brand, and the operation that never existed:
 * that one only ever filled in a blank, so a product assigned to the wrong
 * supplier — or one whose supplier changed — could not be moved from anywhere in
 * the app. This one reassigns, because "these are the things I buy from them" is
 * how a shop actually thinks about it.
 *
 * Products are resolved on the tenant client first, so ids belonging to another
 * workspace simply do not come back and the write cannot reach them.
 */
export async function assignProductsToSupplierAction(input: {
  supplierId: string;
  productIds: string[];
}): Promise<SupplierActionResult> {
  const ctx = await actorContext();
  if (!ctx) return err("You don't have settings access in this workspace.");

  const ids = [...new Set((input.productIds ?? []).filter((id) => typeof id === "string" && id))];
  if (ids.length === 0) return err("Pick at least one product.");
  if (ids.length > ASSIGN_MAX) {
    return err(`Assign up to ${ASSIGN_MAX} products at a time.`);
  }

  const db = prismaForTenant(ctx.tenantId);
  const supplier = await db.supplier.findFirst({
    where: { id: input.supplierId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!supplier) return err("Pick a supplier that still exists.");

  const found = await db.product.findMany({
    where: { id: { in: ids } },
    select: { id: true, supplierId: true },
  });
  if (found.length === 0) return err("Those products no longer exist.");

  const toMove = found.filter((p) => p.supplierId !== supplier.id);
  if (toMove.length === 0) {
    return { ok: true, message: `Already with ${supplier.name}.` };
  }
  const reassigned = toMove.filter((p) => p.supplierId !== null).length;

  const result = await db.product.updateMany({
    where: { id: { in: toMove.map((p) => p.id) } },
    data: { supplierId: supplier.id },
  });

  await audit(ctx.tenantId, supplier.id, "edited", ctx.actor, {
    action: "assign_products",
    supplierName: supplier.name,
    products: result.count,
    // Worth separating in the ledger: filling in a blank is routine, taking
    // products off another supplier is the change someone may ask about.
    reassignedFromAnotherSupplier: reassigned,
  });
  revalidatePath("/suppliers");
  revalidatePath("/stock");
  return {
    ok: true,
    message:
      reassigned > 0
        ? `Moved ${result.count} products to ${supplier.name} (${reassigned} from another supplier).`
        : `Assigned ${result.count} products to ${supplier.name}.`,
  };
}

/**
 * Set (or clear) one product's own lead time.
 *
 * Lead time is what actually decides when to order, and it does not always
 * belong to a supplier: a shop may know an item takes three weeks without
 * wanting to create a supplier record for whoever sends it. Product.leadTimeDays
 * already outranks the supplier's figure everywhere the forecast reads it —
 * nothing had ever written it.
 */
export async function setProductLeadTimeAction(input: {
  productId: string;
  leadTimeDays: number | null;
}): Promise<SupplierActionResult> {
  const ctx = await actorContext();
  if (!ctx) return err("You don't have settings access in this workspace.");

  const lead = normInt(input.leadTimeDays);
  if (lead != null && (lead < 0 || lead > 365)) {
    return err("Lead time should be between 0 and 365 days.");
  }

  const db = prismaForTenant(ctx.tenantId);
  const product = await db.product.findFirst({
    where: { id: input.productId },
    select: { id: true, title: true, leadTimeDays: true },
  });
  if (!product) return err("That product no longer exists.");
  if (product.leadTimeDays === lead) return { ok: true };

  await db.product.update({ where: { id: product.id }, data: { leadTimeDays: lead } });

  await audit(
    ctx.tenantId,
    product.id,
    "edited",
    ctx.actor,
    { action: "product_lead_time", title: product.title, from: product.leadTimeDays, to: lead },
    "Product",
  );
  revalidatePath("/suppliers");
  revalidatePath("/stock");
  return {
    ok: true,
    message: lead == null ? "Back to the supplier's lead time." : `Lead time set to ${lead} days.`,
  };
}

/**
 * Soft-delete a supplier: the row is kept (deletedAt) so PO history and its
 * scorecard survive, and its products are unlinked so they fall back to
 * category/default timing and are re-flagged as unassigned.
 */
export async function deleteSupplierAction(input: {
  supplierId: string;
}): Promise<SupplierActionResult> {
  const ctx = await actorContext();
  if (!ctx) return err("You don't have settings access in this workspace.");

  const outcome = await prismaForTenantTx(ctx.tenantId, async (tx) => {
    const supplier = await tx.supplier.findFirst({
      where: { id: input.supplierId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!supplier) return null;
    const unlinked = await tx.product.updateMany({
      where: { supplierId: supplier.id },
      data: { supplierId: null },
    });
    await tx.supplier.update({ where: { id: supplier.id }, data: { deletedAt: new Date() } });
    return { supplier, unlinked: unlinked.count };
  });
  if (!outcome) return err("That supplier no longer exists.");

  await audit(ctx.tenantId, outcome.supplier.id, "deleted", ctx.actor, {
    name: outcome.supplier.name,
    productsUnlinked: outcome.unlinked,
  });
  revalidatePath("/suppliers");
  return {
    ok: true,
    message:
      outcome.unlinked > 0
        ? `Removed ${outcome.supplier.name}. ${outcome.unlinked} products now need a supplier.`
        : `Removed ${outcome.supplier.name}.`,
  };
}

function audit(
  tenantId: string,
  entityId: string,
  action: string,
  actor: { userId: string; name: string | null },
  meta: Prisma.InputJsonObject,
  /** What the row is about. Defaults to Supplier — the per-product lead-time
   *  override is the one action here whose subject is the product itself, and
   *  filing it under Supplier would make the ledger point at the wrong thing. */
  entity: "Supplier" | "Product" = "Supplier",
): Promise<unknown> {
  return prismaService.auditEvent.create({
    data: {
      tenantId,
      entity,
      entityId,
      action,
      actorUserId: actor.userId,
      actorName: actor.name,
      meta,
    },
  });
}
