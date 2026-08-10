import { BUYABLE_PRODUCT_WHERE, prismaForTenant } from "@wezesha/db";
import { computeSupplierScore } from "@/lib/po/supplier-stats";
import {
  leadTimeDrift,
  learnedLeadMedianDays,
  shortShipRatePct,
  speedBand,
  type LeadTimeDrift,
  type SpeedBand,
} from "@/lib/suppliers/lead-time";
import { suggestSupplierForVendor, type SupplierLite } from "@/lib/suppliers/assign";

/**
 * Suppliers-screen queries. Server-only; explicit tenantId; RLS-enforced tenant
 * client throughout — no query here can read another tenant's rows even if a
 * `where` is wrong.
 *
 * Supplier figures carry no KES cost (MOQ is units, currency is a code, lead
 * times are days), so nothing here is money-blind gated. The learned lead time,
 * short-ship rate and drift flag are all derived from PO receipt history at read
 * time; the typed lead time stays exactly what the owner set (a received
 * delivery never overwrites it — see lib/po/receive-po.ts).
 */

export type SupplierRow = {
  id: string;
  name: string;
  group: string | null;
  country: string | null;
  currency: string;
  email: string | null;
  moq: number;
  /** Owner-set lead time (Supplier.leadTimeAvgDays). null = never set. */
  leadTimeTypedDays: number | null;
  leadTimeStdDays: number;
  /** Median actual lead over the last N deliveries; null below the minimum. */
  learnedLeadDays: number | null;
  /** Completed deliveries scored (deliveredPos). */
  deliveriesTracked: number;
  onTimePct: number | null;
  fillRatePct: number | null;
  shortShipPct: number | null;
  assignedProductCount: number;
  /** Derived from the typed lead time, or the learned one when typed is unset. */
  speedBand: SpeedBand | null;
  drift: LeadTimeDrift;
};

type ScorePo = {
  supplierId: string | null;
  sentAt: Date | null;
  expectedAt: Date | null;
  receivedAt: Date | null;
  lines: { quantity: number; receivedQty: number }[];
};

export async function getSuppliers(tenantId: string): Promise<SupplierRow[]> {
  const db = prismaForTenant(tenantId);
  const [suppliers, productCounts, pos] = await Promise.all([
    db.supplier.findMany({
      where: { deletedAt: null },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        supplierGroup: true,
        country: true,
        currency: true,
        email: true,
        moq: true,
        leadTimeAvgDays: true,
        leadTimeStdDays: true,
      },
    }),
    db.product.groupBy({
      by: ["supplierId"],
      where: { supplierId: { not: null } },
      _count: { _all: true },
    }),
    db.purchaseOrder.findMany({
      where: { deletedAt: null, sentAt: { not: null }, supplierId: { not: null } },
      select: {
        supplierId: true,
        sentAt: true,
        expectedAt: true,
        receivedAt: true,
        lines: { select: { quantity: true, receivedQty: true } },
      },
    }),
  ]);

  const countBySupplier = new Map(
    productCounts.map((c) => [c.supplierId!, c._count._all]),
  );
  const posBySupplier = new Map<string, ScorePo[]>();
  for (const po of pos as ScorePo[]) {
    const list = posBySupplier.get(po.supplierId!) ?? [];
    list.push(po);
    posBySupplier.set(po.supplierId!, list);
  }

  return suppliers.map((s) => {
    const supplierPos = posBySupplier.get(s.id) ?? [];
    const score = computeSupplierScore(supplierPos);
    const completed = supplierPos
      .filter((po) => po.sentAt != null && po.receivedAt != null)
      .map((po) => ({ sentAt: po.sentAt!, receivedAt: po.receivedAt! }));
    const learnedLeadDays = learnedLeadMedianDays(completed);
    const typed = s.leadTimeAvgDays;
    return {
      id: s.id,
      name: s.name,
      group: s.supplierGroup,
      country: s.country,
      currency: s.currency,
      email: s.email,
      moq: s.moq,
      leadTimeTypedDays: typed,
      leadTimeStdDays: s.leadTimeStdDays,
      learnedLeadDays,
      deliveriesTracked: score.deliveredPos,
      onTimePct: score.onTimePct,
      fillRatePct: score.fillRatePct,
      shortShipPct: shortShipRatePct(supplierPos),
      assignedProductCount: countBySupplier.get(s.id) ?? 0,
      speedBand: speedBand(typed ?? learnedLeadDays),
      drift: leadTimeDrift(typed, learnedLeadDays),
    };
  });
}

export type UnassignedBrand = {
  vendor: string;
  productCount: number;
  suggestedSupplierId: string | null;
  suggestedSupplierName: string | null;
};

/**
 * Unassigned products grouped by Shopify vendor (brand), biggest brand first,
 * each with a suggested supplier — the input to the bulk-assign bar. Products
 * with no vendor can't be assigned by brand, so they're left out here.
 */
export async function getUnassignedByBrand(tenantId: string): Promise<UnassignedBrand[]> {
  const db = prismaForTenant(tenantId);
  const [unassigned, assigned, suppliers] = await Promise.all([
    db.product.groupBy({
      by: ["vendor"],
      where: { supplierId: null, ...BUYABLE_PRODUCT_WHERE, vendor: { not: null } },
      _count: { _all: true },
    }),
    db.product.groupBy({
      by: ["vendor", "supplierId"],
      where: { supplierId: { not: null }, vendor: { not: null } },
      _count: { _all: true },
    }),
    db.supplier.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const supplierName = new Map(suppliers.map((s) => [s.id, s.name]));
  const supplierLites: SupplierLite[] = suppliers;
  const countsByVendor = new Map<string, { supplierId: string; count: number }[]>();
  for (const a of assigned) {
    if (!a.vendor || !a.supplierId) continue;
    const list = countsByVendor.get(a.vendor) ?? [];
    list.push({ supplierId: a.supplierId, count: a._count._all });
    countsByVendor.set(a.vendor, list);
  }

  return unassigned
    .filter((u): u is typeof u & { vendor: string } => !!u.vendor)
    .map((u) => {
      const suggestedSupplierId = suggestSupplierForVendor(
        u.vendor,
        supplierLites,
        countsByVendor.get(u.vendor) ?? [],
      );
      return {
        vendor: u.vendor,
        productCount: u._count._all,
        suggestedSupplierId,
        suggestedSupplierName: suggestedSupplierId
          ? (supplierName.get(suggestedSupplierId) ?? null)
          : null,
      };
    })
    .sort((a, b) => b.productCount - a.productCount || a.vendor.localeCompare(b.vendor));
}

export type AssignableProduct = {
  id: string;
  sku: string;
  title: string;
  /** Who it currently belongs to, so picking it is a visible reassignment. */
  supplierName: string | null;
};

/**
 * Candidates for "what do I buy from this supplier?" at the moment the supplier
 * is being created — so there is no supplier id to sort by yet.
 *
 * Same ceiling and the same deliberate non-restriction as the post-creation
 * picker: a shop assigning suppliers is tidying its catalogue, and hiding
 * drafts or deactivated rows would leave items it could never fix.
 */
export async function getAssignableProducts(tenantId: string): Promise<AssignableProduct[]> {
  const db = prismaForTenant(tenantId);
  const rows = await db.product.findMany({
    take: PICKER_LIMIT,
    orderBy: [{ title: "asc" }],
    select: { id: true, sku: true, title: true, supplier: { select: { name: true } } },
  });
  return rows.map((p) => ({
    id: p.id,
    sku: p.sku,
    title: p.title,
    supplierName: p.supplier?.name ?? null,
  }));
}

export type SupplierOption = { id: string; name: string };

/** Active suppliers for the assign/form pickers. */
export async function getSupplierOptions(tenantId: string): Promise<SupplierOption[]> {
  const db = prismaForTenant(tenantId);
  return db.supplier.findMany({
    where: { deletedAt: null },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
}

export type DriftAlert = {
  supplierId: string;
  supplierName: string;
  typedDays: number | null;
  learnedDays: number | null;
  deltaDays: number | null;
  direction: "later" | "earlier" | null;
};

/**
 * Suppliers whose learned lead time has drifted from the typed value — the
 * attention items this surface owns and a Today tile / notification can reuse.
 */
export async function getLeadTimeDriftAlerts(tenantId: string): Promise<DriftAlert[]> {
  const rows = await getSuppliers(tenantId);
  return rows
    .filter((r) => r.drift.drifting)
    .map((r) => ({
      supplierId: r.id,
      supplierName: r.name,
      typedDays: r.leadTimeTypedDays,
      learnedDays: r.learnedLeadDays,
      deltaDays: r.drift.deltaDays,
      direction: r.drift.direction,
    }));
}

export type PickerProduct = {
  id: string;
  title: string;
  sku: string | null;
  vendor: string | null;
  /** The supplier this product sits with today — null when it has none. */
  supplierId: string | null;
  supplierName: string | null;
  /** Per-product lead-time override; null = fall back to the supplier's. */
  leadTimeDays: number | null;
};

export type SupplierProductPicker = {
  supplierId: string;
  supplierName: string;
  /** Products already with this supplier, then the rest. */
  products: PickerProduct[];
  /** True when the list was cut short — the UI says so rather than implying
   *  the shop only has this many products. */
  truncated: boolean;
};

/** Ceiling on the picker list. A shop with thousands of SKUs narrows with the
 *  search box rather than scrolling; sending everything would make the page. */
const PICKER_LIMIT = 300;

/**
 * The candidate list behind "which products do I buy from this supplier?".
 *
 * Deliberately NOT restricted to buyable products: a shop assigning a supplier
 * is tidying its catalogue, and hiding the drafts and deactivated rows would
 * leave items it could never fix. Ordered so the supplier's current products
 * come first — the question is usually "what else", not "what at all".
 */
export async function getSupplierProductPicker(
  tenantId: string,
  supplierId: string,
  search?: string,
): Promise<SupplierProductPicker | null> {
  const db = prismaForTenant(tenantId);
  const supplier = await db.supplier.findFirst({
    where: { id: supplierId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!supplier) return null;

  const term = search?.trim();
  const rows = await db.product.findMany({
    where: term
      ? {
          OR: [
            { title: { contains: term, mode: "insensitive" } },
            { sku: { contains: term, mode: "insensitive" } },
            { vendor: { contains: term, mode: "insensitive" } },
          ],
        }
      : {},
    select: {
      id: true,
      title: true,
      sku: true,
      vendor: true,
      supplierId: true,
      leadTimeDays: true,
      supplier: { select: { name: true } },
    },
    orderBy: [{ title: "asc" }],
    take: PICKER_LIMIT + 1,
  });

  const truncated = rows.length > PICKER_LIMIT;
  const products = rows.slice(0, PICKER_LIMIT).map(
    (p): PickerProduct => ({
      id: p.id,
      title: p.title,
      sku: p.sku,
      vendor: p.vendor,
      supplierId: p.supplierId,
      supplierName: p.supplier?.name ?? null,
      leadTimeDays: p.leadTimeDays,
    }),
  );
  products.sort((a, b) => {
    const mine = Number(b.supplierId === supplier.id) - Number(a.supplierId === supplier.id);
    return mine || a.title.localeCompare(b.title);
  });

  return { supplierId: supplier.id, supplierName: supplier.name, products, truncated };
}
