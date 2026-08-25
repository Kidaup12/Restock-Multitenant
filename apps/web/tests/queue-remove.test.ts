import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { seedDev, type SeedResult } from "../../../packages/db/scripts/seed-dev";
import { runForecast } from "../lib/forecast-run/run";
import { createOrdersForPredictions, getBuyList } from "../lib/data/plan";
import { getOrderQueue, removeQueuedOrder } from "../lib/data/orders";
import { createPoFromOrders } from "../lib/po/create-po";

/**
 * Taking a line back off the order queue.
 *
 * The round trip is the point. A queued product counts as already on the way,
 * so the plan drops it off the buy list; until this existed a mis-ticked line
 * could only leave the queue by becoming a purchase order for stock nobody
 * wanted. Removing it has to put the product back where it came from.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

let seeded: SeedResult;

describe.skipIf(!runnable)("removing a queued line (seeded local db)", () => {
  beforeAll(async () => {
    // Publish must degrade to a no-op without a broker configured.
    delete process.env.REDIS_URL;
    seeded = await seedDev();
    await runForecast(seeded.tenantId);
  }, 120_000);

  afterAll(async () => {
    await prismaService.$disconnect();
  });

  const activeProductIds = async () => {
    const list = await getBuyList(seeded.tenantId, { canViewCosts: true });
    return list!.rows.map((r) => r.productId);
  };

  const queuedOrderFor = (productId: string) =>
    prismaService.order.findFirst({
      where: { tenantId: seeded.tenantId, productId, status: "pending" },
      select: { id: true, orderedQty: true },
    });

  it("puts the product back on the buy list", async () => {
    const before = await getBuyList(seeded.tenantId, { canViewCosts: true });
    expect(before!.rows.length, "the buy list is empty, so nothing can be queued").toBeGreaterThan(
      0
    );
    const target = before!.rows[0]!;

    await createOrdersForPredictions(seeded.tenantId, [target.predictionId]);
    const queued = await queuedOrderFor(target.productId);
    expect(queued, "nothing was queued, so there is nothing to remove").not.toBeNull();
    expect(await activeProductIds()).not.toContain(target.productId);

    expect(await removeQueuedOrder(seeded.tenantId, queued!.id)).toEqual({ ok: true });

    expect(await activeProductIds()).toContain(target.productId);
    expect(await queuedOrderFor(target.productId)).toBeNull();
  });

  it("drops the line from the supplier's queue card", async () => {
    const target = (await getBuyList(seeded.tenantId, { canViewCosts: true }))!.rows[0]!;
    await createOrdersForPredictions(seeded.tenantId, [target.predictionId]);
    const queued = (await queuedOrderFor(target.productId))!;

    const before = await getOrderQueue(seeded.tenantId, { canViewCosts: true });
    expect(before.flatMap((g) => g.lines).map((l) => l.orderId)).toContain(queued.id);

    await removeQueuedOrder(seeded.tenantId, queued.id);

    const after = await getOrderQueue(seeded.tenantId, { canViewCosts: true });
    expect(after.flatMap((g) => g.lines).map((l) => l.orderId)).not.toContain(queued.id);
  });

  it("refuses a line already on a purchase order", async () => {
    const target = (await getBuyList(seeded.tenantId, { canViewCosts: true }))!.rows[0]!;
    await createOrdersForPredictions(seeded.tenantId, [target.predictionId]);
    const queued = (await queuedOrderFor(target.productId))!;

    const po = await createPoFromOrders(seeded.tenantId, [queued.id]);
    expect(po.ok, "no purchase order was cut, so nothing is committed to test").toBe(true);

    // Committed to a supplier now — un-queueing it here would leave the PO
    // asking for stock with no queue row behind it.
    expect(await removeQueuedOrder(seeded.tenantId, queued.id)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await prismaService.order.findUnique({ where: { id: queued.id } })).not.toBeNull();
  });

  it("cannot remove another workspace's queued line", async () => {
    const target = (await getBuyList(seeded.tenantId, { canViewCosts: true }))!.rows[0]!;
    await createOrdersForPredictions(seeded.tenantId, [target.predictionId]);
    const victim = (await queuedOrderFor(target.productId))!;

    const probe = await prismaService.tenant.create({
      data: { name: "Queue Probe", slug: "queue-remove-probe" },
    });
    try {
      expect(await removeQueuedOrder(probe.id, victim.id)).toEqual({
        ok: false,
        reason: "not_found",
      });
      expect(await prismaService.order.findUnique({ where: { id: victim.id } })).not.toBeNull();
    } finally {
      await prismaService.tenant.delete({ where: { id: probe.id } });
    }
  });
});
