import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prismaService } from "@wezesha/db";
import {
  seedDev,
  seedOrdersDemo,
  type SeedResult,
} from "../../../packages/db/scripts/seed-dev";
import { createPoFromOrders } from "../lib/po/create-po";
import { sendPoToSupplier } from "../lib/po/send-po";
import { receivePoLines } from "../lib/po/receive-po";
import { cancelPo } from "../lib/po/cancel-po";
import { getOrderQueue, getPoDetail, getSupplierScores } from "../lib/data/orders";
import { runForecast } from "../lib/forecast-run/run";
import { sendEmail } from "../lib/email";

/**
 * The buying workflow end to end against the seeded local database: queue →
 * PO (MOQ, totals, numbering race) → email to supplier → line-by-line partial
 * receiving → stock + queue completion → supplier learning. The email seam is
 * mocked so the suite captures exactly what would have been sent.
 */

vi.mock("../lib/email", () => ({ sendEmail: vi.fn(async () => {}) }));
const sendEmailMock = vi.mocked(sendEmail);

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const DAY_MS = 86_400_000;

let seeded: SeedResult;
let tenantId: string;
// POs created during the suite (in creation order).
let orbitPoId: string;
let beautyPlusPoId: string;

describe.skipIf(!runnable)("purchase-order flow (seeded local db)", () => {
  beforeAll(async () => {
    seeded = await seedDev();
    tenantId = seeded.tenantId;
    await seedOrdersDemo(tenantId);
  }, 120_000);

  afterAll(async () => {
    await prismaService.$disconnect();
  });

  it("derives supplier scores from the seeded delivery history", async () => {
    const scores = await getSupplierScores(tenantId);
    const suppliers = await prismaService.supplier.findMany({
      where: { tenantId },
      select: { id: true, name: true },
    });
    const idByName = new Map(suppliers.map((s) => [s.name, s.id]));

    // PO-0001: 9 actual vs 10 promised — on time, in full.
    const beautyPlus = scores.get(idByName.get("Beauty Plus Distributors")!)!;
    expect(beautyPlus).toMatchObject({
      deliveredPos: 1,
      onTimePct: 100,
      fillRatePct: 100,
      learnedLeadDays: 9,
    });
    // PO-0002: 25 actual vs 21 promised — late, in full.
    const haria = scores.get(idByName.get("Haria Industries")!)!;
    expect(haria).toMatchObject({
      deliveredPos: 1,
      onTimePct: 0,
      fillRatePct: 100,
      learnedLeadDays: 25,
    });
    // Orbit has no deliveries yet — no invented score.
    expect(scores.get(idByName.get("Orbit Imports")!)).toBeUndefined();
  });

  it("groups the queue by supplier with totals and scorecards", async () => {
    const queue = await getOrderQueue(tenantId, { canViewCosts: true });
    expect(queue).toHaveLength(3);
    const orbit = queue.find((g) => g.supplierName === "Orbit Imports")!;
    expect(orbit.lines.map((l) => l.sku).sort()).toEqual(["CAN-SHE-340", "MAY-COL-BLK"]);
    expect(orbit.totalUnits).toBe(60 + 30);
    const costs = await prismaService.product.findMany({
      where: { tenantId, sku: { in: ["CAN-SHE-340", "MAY-COL-BLK"] } },
      select: { sku: true, costKes: true },
    });
    const costBySku = new Map(costs.map((c) => [c.sku, c.costKes]));
    expect(orbit.totalCostKes).toBe(
      60 * costBySku.get("CAN-SHE-340")! + 30 * costBySku.get("MAY-COL-BLK")!
    );
    const haria = queue.find((g) => g.supplierName === "Haria Industries")!;
    expect(haria.score?.onTimePct).toBe(0);
  });

  it("creates a PO: MOQ floor, cost totals, orders moved and linked", async () => {
    const queue = await getOrderQueue(tenantId, { canViewCosts: true });
    const orbit = queue.find((g) => g.supplierName === "Orbit Imports")!;
    const result = await createPoFromOrders(tenantId, orbit.lines.map((l) => l.orderId), {
      userId: seeded.userId,
      name: "Amara Dev",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    orbitPoId = result.poId;
    // Seeded history holds PO-0001/PO-0002; max+1 continues the series.
    expect(result.poNumber).toBe("PO-0003");

    const po = await prismaService.purchaseOrder.findUnique({
      where: { id: result.poId },
      include: { lines: true, orders: true },
    });
    expect(po?.status).toBe("draft");
    const bySku = new Map(po!.lines.map((l) => [l.sku, l]));
    // CAN-SHE-340: 60 wanted ≥ MOQ 48 — carried as-is.
    expect(bySku.get("CAN-SHE-340")!.quantity).toBe(60);
    // MAY-COL-BLK: 30 wanted < MOQ 48 — floored, recommendation preserved.
    expect(bySku.get("MAY-COL-BLK")!.quantity).toBe(48);
    expect(bySku.get("MAY-COL-BLK")!.recommendedQty).toBe(30);
    const expectedSubtotal = po!.lines.reduce((s, l) => s + l.quantity * l.unitCostKes, 0);
    expect(po!.subtotalKes).toBeCloseTo(expectedSubtotal, 5);
    // The queue rows became on-the-way markers linked to this PO.
    expect(po!.orders).toHaveLength(2);
    expect(po!.orders.every((o) => o.status === "ordered" && o.orderedAt != null)).toBe(true);
    expect(po!.orders.every((o) => o.stockAtOrder != null)).toBe(true);
  });

  it("issues distinct numbers under parallel creation", async () => {
    const queue = await getOrderQueue(tenantId, { canViewCosts: true });
    const beautyPlus = queue.find((g) => g.supplierName === "Beauty Plus Distributors")!;
    const haria = queue.find((g) => g.supplierName === "Haria Industries")!;
    const [a, b] = await Promise.all([
      createPoFromOrders(tenantId, beautyPlus.lines.map((l) => l.orderId)),
      createPoFromOrders(tenantId, haria.lines.map((l) => l.orderId)),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.poNumber).not.toBe(b.poNumber);
    expect([a.poNumber, b.poNumber].sort()).toEqual(["PO-0004", "PO-0005"]);
    beautyPlusPoId = a.poId;
    // Queue fully drained — every group became a PO.
    expect(await getOrderQueue(tenantId, { canViewCosts: true })).toHaveLength(0);
  });

  it("emails the PO through the seam and stamps sent + expected", async () => {
    sendEmailMock.mockClear();
    const result = await sendPoToSupplier(tenantId, orbitPoId, {
      userId: "u-sender",
      name: "The sender",
    });
    expect(result.ok).toBe(true);

    // Sending is a money action and the ledger has to name who did it — every
    // other PO action records an actor, and this one recorded a nameless row.
    const sent = await prismaService.auditEvent.findFirst({
      where: { tenantId, entity: "PurchaseOrder", entityId: orbitPoId, action: "ordered" },
      orderBy: { createdAt: "desc" },
    });
    expect(sent?.actorUserId).toBe("u-sender");
    expect(sent?.actorName).toBe("The sender");

    // ...and the order's own screen names them. The audit row alone is a
    // ledger nobody reads; "Created by X / Sent by —" is what the shop sees.
    const detail = await getPoDetail(tenantId, orbitPoId, { canViewCosts: true });
    expect(detail?.sentByName).toBe("The sender");

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const message = sendEmailMock.mock.calls[0]![0];
    expect(message.to).toBe("orders@orbit-imports.example");
    expect(message.subject).toContain("PO-0003");
    expect(message.text).toContain("CAN-SHE-340");
    expect(message.html).toContain("CAN-SHE-340");

    const po = await prismaService.purchaseOrder.findUnique({ where: { id: orbitPoId } });
    expect(po?.status).toBe("sent");
    expect(po?.sentAt).not.toBeNull();
    // Orbit's typed lead time is 42 days — the ETA is sentAt + 42d.
    const etaDays = (po!.expectedAt!.getTime() - po!.sentAt!.getTime()) / DAY_MS;
    expect(etaDays).toBeCloseTo(42, 5);
    // The on-the-way markers inherit the ETA.
    const orders = await prismaService.order.findMany({
      where: { tenantId, purchaseOrderId: orbitPoId },
    });
    expect(orders.every((o) => o.expectedArrivalAt?.getTime() === po!.expectedAt!.getTime())).toBe(
      true
    );
    // A draft can't be sent twice.
    expect(await sendPoToSupplier(tenantId, orbitPoId)).toEqual({
      ok: false,
      reason: "not_sendable",
    });
  });

  it("rejects over-receipt and foreign locations", async () => {
    const detail = (await getPoDetail(tenantId, orbitPoId, { canViewCosts: true }))!;
    const can = detail.lines.find((l) => l.sku === "CAN-SHE-340")!;
    const primary = detail.locations.find((l) => l.isPrimary)!;
    expect(
      await receivePoLines(tenantId, orbitPoId, [{ lineId: can.id, qty: can.quantity + 1 }], primary.id)
    ).toEqual({ ok: false, reason: "bad_qty" });
    expect(
      await receivePoLines(tenantId, orbitPoId, [{ lineId: can.id, qty: 1 }], "not-a-location")
    ).toEqual({ ok: false, reason: "bad_location" });
  });

  it("receives a partial delivery: line, status, stock and product recompute", async () => {
    const detail = (await getPoDetail(tenantId, orbitPoId, { canViewCosts: true }))!;
    const can = detail.lines.find((l) => l.sku === "CAN-SHE-340")!;
    const primary = detail.locations.find((l) => l.isPrimary)!;
    const levelBefore = await prismaService.inventoryLevel.findUnique({
      where: { locationId_productId: { locationId: primary.id, productId: can.productId } },
    });
    const productBefore = await prismaService.product.findUnique({
      where: { id: can.productId },
    });

    const result = await receivePoLines(
      tenantId,
      orbitPoId,
      [{ lineId: can.id, qty: 25 }],
      primary.id
    );
    expect(result).toEqual({ ok: true, status: "partially_received", receivedUnits: 25 });

    const after = (await getPoDetail(tenantId, orbitPoId, { canViewCosts: true }))!;
    expect(after.status).toBe("partially_received");
    expect(after.lines.find((l) => l.sku === "CAN-SHE-340")!.receivedQty).toBe(25);
    const levelAfter = await prismaService.inventoryLevel.findUnique({
      where: { locationId_productId: { locationId: primary.id, productId: can.productId } },
    });
    expect(levelAfter!.onHand).toBe((levelBefore?.onHand ?? 0) + 25);
    // Stock arriving on a PO is sellable, so available moves with on-hand.
    // Prisma's `increment` would have been NULL + 25 = NULL on a level no
    // available-aware sync had touched, silently erasing what the buy list reads.
    expect(levelAfter!.available).toBe((levelBefore?.available ?? levelBefore?.onHand ?? 0) + 25);
    // currentStock is recomputed from the level sums, so it moves by exactly 25.
    const productAfter = await prismaService.product.findUnique({ where: { id: can.productId } });
    expect(productAfter!.currentStock).toBe(productBefore!.currentStock + 25);
    // Nothing fully received yet — the linked orders stay on the way.
    const orders = await prismaService.order.findMany({
      where: { tenantId, purchaseOrderId: orbitPoId },
    });
    expect(orders.every((o) => o.status === "ordered")).toBe(true);
  });

  it("a receipt onto a level with no available figure establishes one", async () => {
    // The hazard this guards: `available` is nullable, NULL + n is NULL in SQL,
    // and a Prisma `increment` would therefore blank the column on any level no
    // available-aware sync has written — turning a delivery into a stockout.
    const detail = (await getPoDetail(tenantId, orbitPoId, { canViewCosts: true }))!;
    const can = detail.lines.find((l) => l.sku === "CAN-SHE-340")!;
    const primary = detail.locations.find((l) => l.isPrimary)!;
    await prismaService.$executeRaw`
      UPDATE "InventoryLevel" SET "available" = NULL
       WHERE "locationId" = ${primary.id} AND "productId" = ${can.productId}`;
    const before = await prismaService.inventoryLevel.findUnique({
      where: { locationId_productId: { locationId: primary.id, productId: can.productId } },
    });
    expect(before!.available).toBeNull();

    await receivePoLines(tenantId, orbitPoId, [{ lineId: can.id, qty: 5 }], primary.id);

    const after = await prismaService.inventoryLevel.findUnique({
      where: { locationId_productId: { locationId: primary.id, productId: can.productId } },
    });
    // Unknown committed units means "assume none", the same answer
    // sellableUnits() falls back to — so available lands on the new on-hand.
    expect(after!.available).toBe(after!.onHand);
    expect(after!.onHand).toBe(before!.onHand + 5);
  });

  it("completes the delivery: orders completed, lead time learned (typed not overwritten)", async () => {
    // Backdate the send so the learned lead time is a real number of days:
    // sent 20 days ago, promised in 42 — arriving today is early + on time.
    const sentAt = new Date(Date.now() - 20 * DAY_MS);
    const expectedAt = new Date(sentAt.getTime() + 42 * DAY_MS);
    await prismaService.purchaseOrder.update({
      where: { id: orbitPoId },
      data: { sentAt, expectedAt },
    });

    const detail = (await getPoDetail(tenantId, orbitPoId, { canViewCosts: true }))!;
    const primary = detail.locations.find((l) => l.isPrimary)!;
    const remaining = detail.lines
      .filter((l) => l.receivedQty < l.quantity)
      .map((l) => ({ lineId: l.id, qty: l.quantity - l.receivedQty }));
    const result = await receivePoLines(tenantId, orbitPoId, remaining, primary.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("received");

    const po = await prismaService.purchaseOrder.findUnique({
      where: { id: orbitPoId },
      include: { orders: true, supplier: true },
    });
    expect(po!.receivedAt).not.toBeNull();
    expect(po!.orders.every((o) => o.status === "completed" && o.receivedAt != null)).toBe(true);
    // Trust fix: a received delivery no longer overwrites the owner's typed lead
    // time — Orbit's configured 42d ± 10d stands untouched. The 20-day actual is
    // surfaced as the LEARNED value (below), adopted only via "use learned".
    expect(po!.supplier!.leadTimeAvgDays).toBe(42);
    expect(po!.supplier!.leadTimeStdDays).toBe(10);
    // The scorecard now includes Orbit: on time and in full, learned lead 20d.
    const scores = await getSupplierScores(tenantId);
    expect(scores.get(po!.supplierId!)).toMatchObject({
      onTimePct: 100,
      fillRatePct: 100,
      learnedLeadDays: 20,
    });
  });

  it("receiving is tenant-scoped: another tenant can't see or touch the PO", async () => {
    const probe = await prismaService.tenant.create({
      data: { name: "PO Probe", slug: "po-flow-probe" },
    });
    try {
      const detail = await getPoDetail(probe.id, orbitPoId, { canViewCosts: true });
      expect(detail).toBeNull();
      const result = await receivePoLines(
        probe.id,
        orbitPoId,
        [{ lineId: "any", qty: 1 }],
        "any"
      );
      expect(result).toEqual({ ok: false, reason: "not_found" });
    } finally {
      await prismaService.tenant.delete({ where: { id: probe.id } });
    }
  });

  it("cancelling a draft returns its items to the queue", async () => {
    const result = await cancelPo(tenantId, beautyPlusPoId, { userId: "u", name: "Amara Dev" });
    expect(result).toEqual({ ok: true });
    const po = await prismaService.purchaseOrder.findUnique({ where: { id: beautyPlusPoId } });
    expect(po?.status).toBe("cancelled");
    expect(po?.cancelledAt).not.toBeNull();
    const queue = await getOrderQueue(tenantId, { canViewCosts: true });
    const beautyPlus = queue.find((g) => g.supplierName === "Beauty Plus Distributors");
    expect(beautyPlus?.lines).toHaveLength(2);
    // A received PO stays on the books.
    expect(await cancelPo(tenantId, orbitPoId)).toEqual({
      ok: false,
      reason: "not_cancellable",
    });
  });

  it("pending orders survive a forecast re-run (prediction link cleared, not cascaded)", async () => {
    // The forecast replaces every Prediction row per run. Before the schema
    // made Order.predictionId nullable + SET NULL, that delete cascaded into
    // Orders and silently emptied the buying queue on every re-run.
    const product = await prismaService.product.findFirst({
      where: { tenantId, sku: "VEN-HF-150" },
      select: { id: true, currentStock: true },
    });
    const prediction = await prismaService.prediction.create({
      data: {
        tenantId,
        productId: product!.id,
        layer1Forecast30d: 60,
        layer1Confidence: 0.7,
        layer2Adjustment: 0,
        finalForecast30d: 60,
        daysUntilStockout: 8,
        recommendedQty: 48,
        safetyStock: 12,
        reorderPoint: 20,
        confidence: 0.7,
        reasoning: "test",
        urgency: "high",
        signals: "test",
      },
    });
    const order = await prismaService.order.create({
      data: {
        tenantId,
        status: "pending",
        predictionId: prediction.id,
        productId: product!.id,
        orderedQty: 48,
        stockAtOrder: product!.currentStock,
      },
    });

    delete process.env.REDIS_URL; // publish degrades to a no-op
    await runForecast(tenantId);

    // The prediction generation is gone; the queued order stands on its
    // snapshot fields with the provenance link cleared.
    expect(await prismaService.prediction.findUnique({ where: { id: prediction.id } })).toBeNull();
    const after = await prismaService.order.findUnique({ where: { id: order.id } });
    expect(after).not.toBeNull();
    expect(after!.status).toBe("pending");
    expect(after!.predictionId).toBeNull();
    expect(after!.productId).toBe(product!.id);
    expect(after!.orderedQty).toBe(48);
  });
});
