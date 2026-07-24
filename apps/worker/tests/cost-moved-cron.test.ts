import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Cost-moved cron against the local database: the first run establishes the
 * baseline (no alert), a later >20% synced-cost jump raises the attention row +
 * one bell, a sub-threshold move drifts the baseline silently, manual pins and
 * not-for-sale products are excluded, and the same jump never double-notifies.
 * Uses its own fixture tenant. Skips without a local database.
 */

const localDb = /localhost|127\.0\.0\.1/.test(process.env.SERVICE_DATABASE_URL ?? "");
const SLUG = "cost-moved-cron-test";
const NOW = new Date("2026-07-24T05:00:00Z");

describe.skipIf(!localDb)("cost-moved cron (local db)", () => {
  let prismaService: typeof import("@wezesha/db").prismaService;
  let cron: typeof import("../src/cost-moved-cron");
  let tenantId: string;
  const ids: Record<string, string> = {};

  async function makeProduct(key: string, over: Record<string, unknown>) {
    const p = await prismaService.product.create({
      data: { tenantId, sku: key, title: `Product ${key}`, priceKes: 500, ...over },
    });
    ids[key] = p.id;
  }

  beforeAll(async () => {
    ({ prismaService } = await import("@wezesha/db"));
    cron = await import("../src/cost-moved-cron");

    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    const tenant = await prismaService.tenant.create({ data: { name: "Cost Moved Test", slug: SLUG } });
    tenantId = tenant.id;

    await makeProduct("RISE", { costKes: 100, costSource: "shopify" }); // → 130 (+30%) flags
    await makeProduct("SMALL", { costKes: 200, costSource: "shopify" }); // → 230 (+15%) no flag
    await makeProduct("FALL", { costKes: 100, costSource: "shopify" }); // → 70 (-30%) flags
    await makeProduct("PIN", { costKes: 100, costSource: "manual" }); // manual → excluded
    await makeProduct("NFS", { costKes: 100, costSource: "shopify", notForSale: true }); // excluded
    await makeProduct("ZERO", { costKes: 0, costSource: "shopify" }); // missing → skipped
  });

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    await prismaService.$disconnect();
  });

  it("run 1 establishes baselines and never alerts", async () => {
    const res = await cron.checkTenantCostMoves(tenantId, null, NOW);
    expect(res.flagged).toBe(0);
    // RISE, SMALL, FALL baselined; PIN/NFS excluded, ZERO skipped.
    expect(res.rebaselined).toBe(3);

    const rise = await prismaService.product.findUnique({ where: { id: ids.RISE } });
    expect(rise!.lastSyncedCostKes).toBe(100);
    expect(rise!.costMovedPct).toBeNull();
    expect(await prismaService.notification.count({ where: { tenantId, kind: "cost_moved" } })).toBe(0);
  });

  it("run 2 flags a >20% jump (up and down), drifts a small move, ignores pins/nfs/zero", async () => {
    await prismaService.product.update({ where: { id: ids.RISE }, data: { costKes: 130 } });
    await prismaService.product.update({ where: { id: ids.SMALL }, data: { costKes: 230 } });
    await prismaService.product.update({ where: { id: ids.FALL }, data: { costKes: 70 } });
    await prismaService.product.update({ where: { id: ids.PIN }, data: { costKes: 300 } });
    await prismaService.product.update({ where: { id: ids.NFS }, data: { costKes: 500 } });

    const res = await cron.checkTenantCostMoves(tenantId, null, NOW);
    expect(res.flagged).toBe(2); // RISE + FALL

    const rise = await prismaService.product.findUnique({ where: { id: ids.RISE } });
    expect(rise!.costMovedPct).toBe(30);
    expect(rise!.costMovedAt).not.toBeNull();
    expect(rise!.lastSyncedCostKes).toBe(130); // re-baselined

    const fall = await prismaService.product.findUnique({ where: { id: ids.FALL } });
    expect(fall!.costMovedPct).toBe(-30);

    // Sub-threshold: baseline drifts, no alert.
    const small = await prismaService.product.findUnique({ where: { id: ids.SMALL } });
    expect(small!.costMovedPct).toBeNull();
    expect(small!.lastSyncedCostKes).toBe(230);

    // Manual pin + not-for-sale never move.
    const pin = await prismaService.product.findUnique({ where: { id: ids.PIN } });
    expect(pin!.costMovedPct).toBeNull();
    expect(pin!.lastSyncedCostKes).toBeNull();
    const nfs = await prismaService.product.findUnique({ where: { id: ids.NFS } });
    expect(nfs!.costMovedPct).toBeNull();

    const notes = await prismaService.notification.findMany({ where: { tenantId, kind: "cost_moved" }, orderBy: { title: "asc" } });
    expect(notes).toHaveLength(2);
    expect(notes.map((n) => n.title)).toContain("Product RISE cost rose +30%");
    expect(notes.map((n) => n.title)).toContain("Product FALL cost fell -30%");
  });

  it("run 3 does not re-fire the same jump", async () => {
    const res = await cron.checkTenantCostMoves(tenantId, null, NOW);
    expect(res.flagged).toBe(0);
    expect(await prismaService.notification.count({ where: { tenantId, kind: "cost_moved" } })).toBe(2);
  });
});
