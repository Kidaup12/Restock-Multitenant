"use server";

import { revalidatePath } from "next/cache";
import { Prisma, prismaForTenant, prismaService } from "@wezesha/db";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission, type PermissionKey } from "@/lib/auth/permissions";
import { selectRows, status, type CatalogueQuery } from "@/lib/catalogue";
import { getStockCatalogue } from "@/lib/data/stock";
import type { CatalogueExportRow } from "./catalogue-export";

/**
 * Catalogue row-editor writes: the manual cost pin (and its release back to the
 * synced cost), the typed selling price, archive / restore / keep-active, the
 * not-for-sale toggle, and category assign / rename / delete.
 *
 * Every action re-resolves the caller's membership server-side and re-checks the
 * required permission; the tenant id comes from the membership, never the client.
 * Cost edits also require `view_costs` — you can't pin a cost you're not allowed
 * to see. Writes run on the RLS-scoped tenant client (a foreign id resolves to
 * nothing); the audit row rides the service client so no tenant role can filter
 * it. The sync guard already refuses to overwrite a manual pin, so setting
 * costSource="manual" is what makes an owner's cost stick.
 */

export type CatalogueActionResult =
  | { ok: true; message?: string }
  | { ok: false; error: string };

const err = (error: string): CatalogueActionResult => ({ ok: false, error });

async function actorContext(need: PermissionKey[]) {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) return null;
  for (const key of need) if (!hasPermission(membership, key)) return null;
  return {
    tenantId: membership.tenantId,
    currency: membership.tenant.currency,
    actor: {
      userId: session.user.id,
      name: membership.displayName ?? session.user.name ?? session.user.email,
    },
  };
}

function audit(
  tenantId: string,
  productId: string,
  action: string,
  actor: { userId: string; name: string | null },
  meta: Prisma.InputJsonObject,
): Promise<unknown> {
  return prismaService.auditEvent.create({
    data: { tenantId, entity: "Product", entityId: productId, action, actorUserId: actor.userId, actorName: actor.name, meta },
  });
}

function revalidateCatalogue() {
  revalidatePath("/products");
  revalidatePath("/costs");
  // Archiving a SKU, or fixing its cost, changes what the buy list contains —
  // leaving the plan cached would show it ordering something just retired.
  revalidatePath("/plan");
}

// ── Export ───────────────────────────────────────────────────────────────────

/**
 * Every row the reader's filters match, for the export — not just the page on
 * screen. The table only receives one page now, so the browser can no longer
 * build the file from what it holds; it asks for the full matched list at the
 * moment the reader clicks.
 *
 * `canViewCosts` is re-derived from the caller's own membership, exactly as the
 * screen does. A money-blind member's export cannot carry costs even if the
 * request says otherwise — the redaction happens in the getter, at the data
 * layer, and this path is no exception.
 */
export async function exportCatalogueAction(query: CatalogueQuery): Promise<CatalogueExportRow[]> {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) return [];

  const canViewCosts = hasPermission(membership, "view_costs");
  const rows = await getStockCatalogue(membership.tenantId, { canViewCosts });
  return selectRows(rows, query).map((row) => ({
    title: row.title,
    sku: row.sku,
    supplierName: row.supplierName,
    leadDays: row.leadDays,
    onHandUnits: row.onHandUnits,
    warehouseUnits: row.warehouseUnits,
    // An empty shelf has no cover to report, matching the table.
    daysCover: row.onHandUnits <= 0 ? null : row.daysCover,
    status: status(row).label,
    costKes: row.costKes,
    stockValueKes: row.stockValueKes,
  }));
}

// ── Manual cost pin ──────────────────────────────────────────────────────────

/**
 * Pin a typed cost: writes costKes + costSource="manual" so the sync can't
 * overwrite it (spec §2 priority tier 1). A zero/negative is rejected — a zero
 * cost is "missing", never a real cost.
 */
export async function setManualCostAction(input: {
  productId: string;
  costKes: number;
}): Promise<CatalogueActionResult> {
  const ctx = await actorContext(["view_costs", "manage_settings"]);
  if (!ctx) return err("You don't have cost-editing access in this workspace.");

  const cost = Number(input.costKes);
  if (!Number.isFinite(cost) || cost <= 0) return err("Enter a cost greater than zero.");
  const rounded = Math.round(cost * 100) / 100;

  const db = prismaForTenant(ctx.tenantId);
  const product = await db.product.findFirst({
    where: { id: input.productId },
    select: { id: true, title: true, costKes: true, costSource: true },
  });
  if (!product) return err("That product no longer exists.");

  await db.product.update({
    where: { id: product.id },
    data: { costKes: rounded, costSource: "manual", costUpdatedAt: new Date(), costMovedPct: null, costMovedAt: null },
  });
  await audit(ctx.tenantId, product.id, "cost_changed", ctx.actor, {
    field: "costKes",
    from: product.costKes,
    to: rounded,
    source: "manual",
    previousSource: product.costSource,
  });
  revalidateCatalogue();
  return { ok: true, message: `Pinned ${product.title} cost to ${ctx.currency} ${rounded.toLocaleString("en-KE")}.` };
}

/**
 * Release the pin ("use synced cost"): restores the last synced cost when we
 * retained one (labelled shopify), else clears to missing so the next sync fills
 * it. Either way costSource leaves "manual", handing the field back to the sync.
 */
export async function clearCostPinAction(input: {
  productId: string;
}): Promise<CatalogueActionResult> {
  const ctx = await actorContext(["view_costs", "manage_settings"]);
  if (!ctx) return err("You don't have cost-editing access in this workspace.");

  const db = prismaForTenant(ctx.tenantId);
  const product = await db.product.findFirst({
    where: { id: input.productId },
    select: { id: true, title: true, costKes: true, costSource: true, lastSyncedCostKes: true },
  });
  if (!product) return err("That product no longer exists.");
  if (product.costSource !== "manual") return err("That cost isn't pinned.");

  const synced = product.lastSyncedCostKes != null && product.lastSyncedCostKes > 0 ? product.lastSyncedCostKes : null;
  await db.product.update({
    where: { id: product.id },
    data: {
      costKes: synced ?? 0,
      costSource: synced != null ? "shopify" : null,
      costUpdatedAt: new Date(),
      costMovedPct: null,
      costMovedAt: null,
    },
  });
  await audit(ctx.tenantId, product.id, "cost_changed", ctx.actor, {
    action: "clear_pin",
    from: product.costKes,
    to: synced ?? 0,
    source: synced != null ? "shopify" : "missing",
  });
  revalidateCatalogue();
  return {
    ok: true,
    message: synced != null ? `${product.title} back to the synced cost.` : `${product.title} pin cleared — awaiting a synced cost.`,
  };
}

// ── Selling price ────────────────────────────────────────────────────────────

/**
 * Type the shop's selling price.
 *
 * Deliberately NOT pinned the way cost is. A pinned cost is right because the
 * shop's real landed cost lives on a supplier invoice the store never sees; the
 * selling price is the opposite — the store and the till are what actually
 * charge the customer, and a price only this app believes would put margin and
 * revenue-at-risk out of step with the money the shop takes. So the catalogue
 * sync stays the source of record and the next pull brings the store's price
 * back; the editor says so in as many words rather than letting the owner find
 * out when the number reverts. On a row the sync doesn't own (no Shopify
 * variant — an imported or till-only product) nothing overwrites it, so a typed
 * price simply stands.
 *
 * Gated exactly like the cost pin: price feeds margin, and margin is the
 * money-blind boundary.
 */
export async function setPriceAction(input: {
  productId: string;
  priceKes: number;
}): Promise<CatalogueActionResult> {
  const ctx = await actorContext(["view_costs", "manage_settings"]);
  if (!ctx) return err("You don't have price-editing access in this workspace.");

  const price = Number(input.priceKes);
  if (!Number.isFinite(price) || price < 0) return err("Enter a price of zero or more.");
  const rounded = Math.round(price * 100) / 100;

  const db = prismaForTenant(ctx.tenantId);
  const product = await db.product.findFirst({
    where: { id: input.productId },
    select: { id: true, title: true, priceKes: true, shopifyVariantId: true },
  });
  if (!product) return err("That product no longer exists.");

  await db.product.update({ where: { id: product.id }, data: { priceKes: rounded } });
  await audit(ctx.tenantId, product.id, "price_changed", ctx.actor, {
    field: "priceKes",
    from: product.priceKes,
    to: rounded,
  });
  revalidateCatalogue();
  return {
    ok: true,
    message: product.shopifyVariantId
      ? `${product.title} price set to ${ctx.currency} ${rounded.toLocaleString("en-KE")} — the next store sync will bring the store's price back.`
      : `${product.title} price set to ${ctx.currency} ${rounded.toLocaleString("en-KE")}.`,
  };
}

// ── Archive / restore / keep active ──────────────────────────────────────────

/** What the owner is doing to a SKU's life, independent of the store's status. */
export type ProductActiveMode = "archive" | "restore" | "keep_active";

const ACTIVE_MODES: Record<ProductActiveMode, { active: boolean; activeOverride: boolean }> = {
  // Archiving clears any earlier pin: keeping the sync locked out of a row the
  // owner just retired would leave two contradictory owner decisions on it.
  archive: { active: false, activeOverride: false },
  restore: { active: true, activeOverride: false },
  keep_active: { active: true, activeOverride: true },
};

/**
 * Archive / restore / keep-active — the owner's own switch on a SKU.
 *
 * `active` is one half of the buy-list predicate, so archiving drops the row off
 * the buy list and out of the default (selling) catalogue view the moment it is
 * written; it keeps its stock, cash and history, under the archived scope.
 * "Keep active" additionally pins `activeOverride`, which is what stops the next
 * catalogue sync pushing the row back out — see the product upsert in the worker.
 */
export async function setProductActiveAction(input: {
  productId: string;
  mode: ProductActiveMode;
}): Promise<CatalogueActionResult> {
  const ctx = await actorContext(["manage_settings"]);
  if (!ctx) return err("You don't have settings access in this workspace.");

  const next = ACTIVE_MODES[input.mode];
  if (!next) return err("Unknown catalogue action.");

  const db = prismaForTenant(ctx.tenantId);
  const product = await db.product.findFirst({
    where: { id: input.productId },
    select: { id: true, title: true, active: true, activeOverride: true },
  });
  if (!product) return err("That product no longer exists.");

  await db.product.update({ where: { id: product.id }, data: next });
  await audit(ctx.tenantId, product.id, "edited", ctx.actor, {
    field: "active",
    mode: input.mode,
    from: product.active,
    to: next.active,
    activeOverride: next.activeOverride,
  });
  revalidateCatalogue();

  const message =
    input.mode === "archive"
      ? `${product.title} archived — off the buy list, still in the archived view.`
      : input.mode === "keep_active"
        ? `${product.title} kept active — the store's status won't archive it.`
        : `${product.title} restored.`;
  return { ok: true, message };
}

// ── Not-for-sale toggle ──────────────────────────────────────────────────────

export async function setNotForSaleAction(input: {
  productId: string;
  notForSale: boolean;
}): Promise<CatalogueActionResult> {
  const ctx = await actorContext(["manage_settings"]);
  if (!ctx) return err("You don't have settings access in this workspace.");

  const db = prismaForTenant(ctx.tenantId);
  const product = await db.product.findFirst({ where: { id: input.productId }, select: { id: true, title: true } });
  if (!product) return err("That product no longer exists.");

  const notForSale = Boolean(input.notForSale);
  await db.product.update({ where: { id: product.id }, data: { notForSale } });
  await audit(ctx.tenantId, product.id, "edited", ctx.actor, { field: "notForSale", to: notForSale });
  revalidateCatalogue();
  return {
    ok: true,
    message: notForSale ? `${product.title} marked not for sale.` : `${product.title} back on sale.`,
  };
}

// ── Categories (owner-defined; live on Product.customCategory, no table) ──────

const MAX_CATEGORY = 60;
const cleanCategory = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t.slice(0, MAX_CATEGORY) : null;
};

/** Assign a product to a category — the create-by-assign path ("+ New category"
 *  inline): a brand-new name becomes a real category the moment it's assigned. */
export async function assignCategoryAction(input: {
  productId: string;
  category: string | null;
}): Promise<CatalogueActionResult> {
  const ctx = await actorContext(["manage_settings"]);
  if (!ctx) return err("You don't have settings access in this workspace.");

  const category = cleanCategory(input.category);
  const db = prismaForTenant(ctx.tenantId);
  const product = await db.product.findFirst({ where: { id: input.productId }, select: { id: true, title: true, customCategory: true } });
  if (!product) return err("That product no longer exists.");

  await db.product.update({ where: { id: product.id }, data: { customCategory: category } });
  await audit(ctx.tenantId, product.id, "edited", ctx.actor, { field: "customCategory", from: product.customCategory, to: category });
  revalidateCatalogue();
  return { ok: true, message: category ? `${product.title} → ${category}.` : `${product.title} uncategorised.` };
}

/** Rename a category across every product that carries it. */
export async function renameCategoryAction(input: {
  from: string;
  to: string;
}): Promise<CatalogueActionResult> {
  const ctx = await actorContext(["manage_settings"]);
  if (!ctx) return err("You don't have settings access in this workspace.");

  const from = cleanCategory(input.from);
  const to = cleanCategory(input.to);
  if (!from) return err("Pick a category to rename.");
  if (!to) return err("Give the category a name.");
  if (from === to) return err("That's already the name.");

  const db = prismaForTenant(ctx.tenantId);
  const result = await db.product.updateMany({ where: { customCategory: from }, data: { customCategory: to } });
  if (result.count === 0) return err("No products are in that category.");

  await audit(ctx.tenantId, "-", "edited", ctx.actor, { action: "rename_category", from, to, products: result.count });
  revalidateCatalogue();
  return { ok: true, message: `Renamed "${from}" to "${to}" (${result.count} products).` };
}

/** Delete a category: clears it from its products (they keep working,
 *  uncategorised) — spec "delete-clears-field". */
export async function deleteCategoryAction(input: {
  name: string;
}): Promise<CatalogueActionResult> {
  const ctx = await actorContext(["manage_settings"]);
  if (!ctx) return err("You don't have settings access in this workspace.");

  const name = cleanCategory(input.name);
  if (!name) return err("Pick a category to delete.");

  const db = prismaForTenant(ctx.tenantId);
  const result = await db.product.updateMany({ where: { customCategory: name }, data: { customCategory: null } });
  if (result.count === 0) return err("No products are in that category.");

  await audit(ctx.tenantId, "-", "edited", ctx.actor, { action: "delete_category", name, products: result.count });
  revalidateCatalogue();
  return { ok: true, message: `Deleted "${name}" — ${result.count} products now uncategorised.` };
}

// ── Bulk lead time ───────────────────────────────────────────────────────────

/** How many products one call may set. Generous enough for "the whole brand",
 *  small enough that a malformed payload cannot rewrite the catalogue. */
const LEAD_TIME_MAX_PRODUCTS = 500;

/** Longest lead time worth typing; matches the single-product editor. */
const LEAD_TIME_MAX_DAYS = 365;

/**
 * Set one lead time across many products at once.
 *
 * Lead time is what decides WHEN to order — an order-by date computed with no
 * lead time assumes stock appears the moment it is ordered. Until now the only
 * way to set it was one product at a time, from a field inside the supplier's
 * product picker, which is why not a single product in any live workspace has
 * one. A shop that buys most of its shelf from two importers wants to say "these
 * take three weeks" once, not four hundred times.
 *
 * Two ways to choose the products, because the useful selections are different
 * sizes: an explicit list of ids (what the reader ticked), or the reader's
 * current filters (what "select all 312 matching" means — the rows are on the
 * server, so the browser cannot enumerate them). The query route re-derives the
 * match here rather than trusting a count from the client, exactly as the
 * catalogue export does.
 *
 * Either way the ids are resolved on the RLS-scoped tenant client before the
 * write, so an id belonging to another workspace simply does not come back.
 */
export async function setLeadTimeForProductsAction(input: {
  leadTimeDays: number | null;
  productIds?: string[];
  query?: CatalogueQuery;
}): Promise<CatalogueActionResult> {
  const ctx = await actorContext(["manage_settings"]);
  if (!ctx) return err("You don't have settings access in this workspace.");

  const lead =
    input.leadTimeDays == null || Number.isNaN(input.leadTimeDays)
      ? null
      : Math.round(input.leadTimeDays);
  if (lead != null && (lead < 0 || lead > LEAD_TIME_MAX_DAYS)) {
    return err(`Lead time should be between 0 and ${LEAD_TIME_MAX_DAYS} days.`);
  }

  const db = prismaForTenant(ctx.tenantId);

  let ids: string[];
  if (input.query) {
    // canViewCosts only decides which columns come back; the rows themselves are
    // the same list either way, so a money-blind admin selects the same set.
    const rows = await getStockCatalogue(ctx.tenantId, { canViewCosts: false });
    ids = selectRows(rows, input.query).map((r) => r.productId);
  } else {
    ids = [...new Set((input.productIds ?? []).filter((id) => typeof id === "string" && id))];
  }

  if (ids.length === 0) return err("Pick at least one product.");
  if (ids.length > LEAD_TIME_MAX_PRODUCTS) {
    return err(`Set up to ${LEAD_TIME_MAX_PRODUCTS} products at a time — narrow the list and repeat.`);
  }

  const found = await db.product.findMany({
    where: { id: { in: ids } },
    select: { id: true, leadTimeDays: true },
  });
  if (found.length === 0) return err("Those products no longer exist.");

  // Only the ones actually changing: a no-op write would still land an audit row
  // saying a lead time moved when none did.
  const changing = found.filter((p) => p.leadTimeDays !== lead).map((p) => p.id);
  if (changing.length === 0) {
    return { ok: true, message: lead == null ? "Already unset." : `Already ${lead} days.` };
  }

  const result = await db.product.updateMany({
    where: { id: { in: changing } },
    data: { leadTimeDays: lead },
  });

  await audit(ctx.tenantId, "-", "edited", ctx.actor, {
    action: "bulk_lead_time",
    to: lead,
    products: result.count,
    // How the set was chosen is worth keeping: "all 312 matching" and "these
    // three" are very different actions to find in the ledger later.
    scope: input.query ? "filtered" : "picked",
  });
  revalidateCatalogue();
  revalidatePath("/suppliers");
  revalidatePath("/plan");
  return {
    ok: true,
    message:
      lead == null
        ? `Cleared the lead time on ${result.count} products.`
        : `Lead time set to ${lead} days on ${result.count} products.`,
  };
}
