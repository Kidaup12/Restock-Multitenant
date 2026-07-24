import { Prisma, prismaForTenantTx, prismaService } from "@wezesha/db";
import { aggregateStoredPosLines, dayMarker, normalizeSku, tenantDayKey } from "@wezesha/pos";

/**
 * Owner "downstream fixes" for POS data — the writes behind the Sales fix queue.
 * The tenant mutations run RLS-scoped (prismaForTenantTx); the audit rows ride
 * the service client, the iron rule for the ledger. Admin-gating lives in the
 * server actions (this layer stays a testable core, like lib/po/*).
 */

type Actor = { userId: string; name: string };

/** Re-derive one product's channel="pos" SalesHistory from its stored matched
 *  lines — the shared core of Match and the re-derive repair, run inside a tx. */
async function rederiveProductPosHistory(
  tx: Prisma.TransactionClient,
  tenantId: string,
  productId: string,
  price: number,
  timezone: string
): Promise<void> {
  const maps = await tx.warehouseLocationMap.findMany({
    where: { tenantId },
    select: { warehouseName: true, locationId: true },
  });
  const warehouseToLocationId = new Map(maps.map((m) => [normalizeSku(m.warehouseName), m.locationId]));

  const lines = await tx.posSaleLine.findMany({
    where: { tenantId, productId },
    select: { qty: true, price: true, subtotal: true, posSale: { select: { date: true, warehouse: true } } },
  });
  const rows = aggregateStoredPosLines(
    lines.map((l) => ({
      productId,
      qty: l.qty,
      price: l.price,
      subtotal: l.subtotal,
      saleDate: l.posSale.date,
      warehouse: l.posSale.warehouse,
    })),
    {
      priceByProductId: new Map([[productId, price]]),
      warehouseToLocationId,
      dayKeyOf: (d) => tenantDayKey(timezone, d),
    }
  );

  // Full per-product re-derive: clear this product's POS rows, rewrite from scratch.
  await tx.salesHistory.deleteMany({ where: { tenantId, productId, channel: "pos" } });
  if (rows.length > 0) {
    await tx.salesHistory.createMany({
      data: rows.map((r) => ({
        tenantId,
        productId,
        date: dayMarker(r.dayKey),
        quantity: r.quantity,
        revenueKes: r.revenueKes,
        channel: "pos",
        locationId: r.locationId,
      })),
    });
  }
}

export type MatchPosSkuResult =
  | { ok: true; matchedLines: number }
  | { ok: false; reason: "no_product" | "no_lines" | "bad_sku" };

/**
 * Link a till SKU to a catalogue product: set PosSaleLine.productId on every
 * unmatched line with that (normalized) SKU, then back-fill the product's POS
 * SalesHistory so its run rate includes the recovered sales. Idempotent.
 */
export async function matchPosSku(
  tenantId: string,
  input: { sku: string; productId: string },
  actor: Actor
): Promise<MatchPosSkuResult> {
  const target = normalizeSku(input.sku);
  if (!target) return { ok: false, reason: "bad_sku" };

  const result = await prismaForTenantTx(tenantId, async (tx): Promise<MatchPosSkuResult> => {
    const product = await tx.product.findFirst({
      where: { id: input.productId, tenantId },
      select: { id: true, priceKes: true },
    });
    if (!product) return { ok: false, reason: "no_product" as const };

    // Case-insensitive SKU match: normalize in JS (Prisma has no portable
    // lower() filter), collect ids, update by id.
    const candidates = await tx.posSaleLine.findMany({
      where: { tenantId, productId: null },
      select: { id: true, sku: true },
    });
    const ids = candidates.filter((l) => normalizeSku(l.sku) === target).map((l) => l.id);
    if (ids.length === 0) return { ok: false, reason: "no_lines" as const };
    await tx.posSaleLine.updateMany({ where: { id: { in: ids } }, data: { productId: product.id } });

    const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
    await rederiveProductPosHistory(tx, tenantId, product.id, product.priceKes ?? 0, tenant?.timezone ?? "Africa/Nairobi");
    return { ok: true as const, matchedLines: ids.length };
  });

  if (result.ok) {
    await prismaService.auditEvent.create({
      data: {
        tenantId,
        entity: "Product",
        entityId: input.productId,
        action: "pos_sku_matched",
        actorUserId: actor.userId,
        actorName: actor.name,
        meta: { sku: input.sku.trim(), matchedLines: result.matchedLines },
      },
    });
  }
  return result;
}

/**
 * "Not a product, ignore this till SKU": a persistent IgnoreRule so junk codes
 * (bags, airtime) never re-queue and never enter run rate. Stored normalized so
 * re-ignoring the same code is a no-op.
 */
export async function ignorePosSku(
  tenantId: string,
  input: { sku: string },
  actor: Actor
): Promise<{ ok: true } | { ok: false; reason: "bad_sku" }> {
  const value = normalizeSku(input.sku);
  if (!value) return { ok: false, reason: "bad_sku" };

  await prismaForTenantTx(tenantId, async (tx) => {
    await tx.ignoreRule.upsert({
      where: { tenantId_kind_value: { tenantId, kind: "till_sku", value } },
      create: { tenantId, kind: "till_sku", value, createdByUserId: actor.userId },
      update: {},
    });
  });
  await prismaService.auditEvent.create({
    data: {
      tenantId,
      entity: "IgnoreRule",
      entityId: value,
      action: "pos_sku_ignored",
      actorUserId: actor.userId,
      actorName: actor.name,
      meta: { sku: input.sku.trim(), kind: "till_sku" },
    },
  });
  return { ok: true };
}

/**
 * Dismiss a sales gap as "shop was closed": write a LocationClosure the forecast
 * honours later (a real no-trading day, not lost sales). Suppresses the gap on
 * the next read.
 */
export async function dismissGapAsClosure(
  tenantId: string,
  input: { locationId: string; dayKey: string },
  actor: Actor
): Promise<{ ok: true } | { ok: false; reason: "no_location" | "bad_day" }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dayKey)) return { ok: false, reason: "bad_day" };

  const outcome = await prismaForTenantTx(
    tenantId,
    async (tx): Promise<{ ok: true } | { ok: false; reason: "no_location" }> => {
      const location = await tx.location.findFirst({
        where: { id: input.locationId, tenantId },
        select: { id: true },
      });
      if (!location) return { ok: false, reason: "no_location" as const };
      await tx.locationClosure.upsert({
        where: { locationId_date: { locationId: input.locationId, date: dayMarker(input.dayKey) } },
        create: {
          tenantId,
          locationId: input.locationId,
          date: dayMarker(input.dayKey),
          reason: "closed",
          createdByUserId: actor.userId,
        },
        update: { reason: "closed" },
      });
      return { ok: true as const };
    }
  );

  if (outcome.ok) {
    await prismaService.auditEvent.create({
      data: {
        tenantId,
        entity: "LocationClosure",
        entityId: input.locationId,
        action: "sales_gap_closed",
        actorUserId: actor.userId,
        actorName: actor.name,
        meta: { dayKey: input.dayKey },
      },
    });
  }
  return outcome;
}
