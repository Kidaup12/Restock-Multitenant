import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * POS fix-queue reads + the Match/Ignore/close-gap write core against the local
 * database. Exercises the RLS-scoped lib layer the Sales-screen actions wrap
 * (admin-gating is a thin check in actions.ts). Uses its own fixture tenant;
 * skips without a local database.
 */

const localDb = /localhost|127\.0\.0\.1/.test(process.env.SERVICE_DATABASE_URL ?? "");
const SLUG = "pos-web-test";
const ACTOR = { userId: "tester", name: "Tester" };
const day = (d: string) => new Date(`${d}T00:00:00.000Z`);

describe.skipIf(!localDb)("pos fix queue (local db)", () => {
  let prismaService: typeof import("@wezesha/db").prismaService;
  let queues: typeof import("@/lib/data/pos-queues");
  let match: typeof import("@/lib/pos/match");
  let tenantId: string;
  let p1: string; // CAN-SHE-340
  let p2: string; // NL-GLY-750
  let branchA: string;
  let branchB: string;

  async function seedPosLines() {
    const ps1 = await prismaService.posSale.create({
      data: {
        tenantId,
        externalId: "PS1",
        date: new Date("2026-07-15T10:00:00Z"),
        createdBy: "Grace",
        warehouse: "Kilimani",
      },
    });
    const ps2 = await prismaService.posSale.create({
      data: {
        tenantId,
        externalId: "PS2",
        date: new Date("2026-07-16T10:00:00Z"),
        createdBy: "Grace",
        warehouse: "Kilimani",
      },
    });
    await prismaService.posSaleLine.createMany({
      data: [
        { tenantId, posSaleId: ps1.id, sku: "CAN-SHE-340", productName: "Cantu", qty: 2, subtotal: 3300, productId: p1 },
        { tenantId, posSaleId: ps1.id, sku: "MYSTERY-XYZ", productName: "Mystery", qty: 3, subtotal: 300, productId: null },
        { tenantId, posSaleId: ps1.id, sku: "CARRIER-BAG", productName: "Bag", qty: 5, subtotal: 50, productId: null },
        { tenantId, posSaleId: ps2.id, sku: "mystery-xyz", productName: "Mystery", qty: 1, subtotal: 100, productId: null },
      ],
    });
    // An unmapped till (Kilimani is mapped; Pop-up is not).
    await prismaService.posSale.create({
      data: { tenantId, externalId: "PS3", date: new Date("2026-07-16T12:00:00Z"), createdBy: "Grace", warehouse: "Pop-up" },
    });
  }

  beforeAll(async () => {
    ({ prismaService } = await import("@wezesha/db"));
    queues = await import("@/lib/data/pos-queues");
    match = await import("@/lib/pos/match");

    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    const tenant = await prismaService.tenant.create({
      data: { name: "POS Web Test", slug: SLUG, timezone: "Africa/Nairobi" },
    });
    tenantId = tenant.id;
    const cantu = await prismaService.product.create({
      data: { tenantId, sku: "CAN-SHE-340", title: "Cantu Shea Butter Leave-In 340g", priceKes: 1650 },
    });
    p1 = cantu.id;
    const gly = await prismaService.product.create({
      data: { tenantId, sku: "NL-GLY-750", title: "Nice & Lovely Pure Glycerine 750ml", priceKes: 450 },
    });
    p2 = gly.id;
    const a = await prismaService.location.create({
      data: { tenantId, name: "Kilimani", locationType: "branch", roleStatus: "confirmed" },
    });
    branchA = a.id;
    const b = await prismaService.location.create({
      data: { tenantId, name: "Westlands", locationType: "branch", roleStatus: "confirmed" },
    });
    branchB = b.id;
    await prismaService.warehouseLocationMap.create({
      data: { tenantId, warehouseName: "Kilimani", locationId: branchA },
    });
  });

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    await prismaService.$disconnect();
  });

  beforeEach(async () => {
    await prismaService.posSale.deleteMany({ where: { tenantId } });
    await prismaService.salesHistory.deleteMany({ where: { tenantId } });
    await prismaService.ignoreRule.deleteMany({ where: { tenantId } });
    await prismaService.locationClosure.deleteMany({ where: { tenantId } });
  });

  it("rolls up unmatched till SKUs, excluding ignored ones", async () => {
    await seedPosLines();
    await prismaService.ignoreRule.create({ data: { tenantId, kind: "till_sku", value: "carrier-bag" } });

    const rows = await queues.getUnmatchedPosSkus(tenantId);
    expect(rows).toHaveLength(1); // CARRIER-BAG ignored, MYSTERY-XYZ rolled up across casings
    expect(rows[0]).toMatchObject({ sku: "MYSTERY-XYZ", units: 4, revenueKes: 400 });
  });

  it("surfaces unmapped tills but not mapped ones", async () => {
    await seedPosLines();
    const tills = await queues.getUnmappedTills(tenantId);
    expect(tills.map((t) => t.warehouse)).toEqual(["Pop-up"]);
  });

  it("Match links the SKU to a product and back-fills SalesHistory (run rate)", async () => {
    await seedPosLines();
    const result = await match.matchPosSku(tenantId, { sku: "MYSTERY-XYZ", productId: p2 }, ACTOR);
    expect(result).toEqual({ ok: true, matchedLines: 2 });

    // Both lines (both casings) now point at the product.
    const linked = await prismaService.posSaleLine.count({ where: { tenantId, productId: p2 } });
    expect(linked).toBe(2);

    // SalesHistory channel="pos" back-filled for the two days, attributed to Kilimani.
    const sh = await prismaService.salesHistory.findMany({
      where: { tenantId, productId: p2, channel: "pos" },
      orderBy: { date: "asc" },
    });
    expect(sh).toHaveLength(2);
    expect(sh[0]).toMatchObject({ quantity: 3, revenueKes: 300, locationId: branchA });
    expect(sh[0]!.date.toISOString().slice(0, 10)).toBe("2026-07-15");
    expect(sh[1]).toMatchObject({ quantity: 1, revenueKes: 100 });

    // It leaves the queue (CARRIER-BAG is still unmatched), and an audit row records who did it.
    const remaining = await queues.getUnmatchedPosSkus(tenantId);
    expect(remaining.map((r) => r.sku)).toEqual(["CARRIER-BAG"]);
    const audit = await prismaService.auditEvent.findFirst({ where: { tenantId, action: "pos_sku_matched" } });
    expect(audit?.meta).toMatchObject({ sku: "MYSTERY-XYZ", matchedLines: 2 });
  });

  it("Ignore writes a persistent till_sku rule so the SKU never re-queues", async () => {
    await seedPosLines();
    const result = await match.ignorePosSku(tenantId, { sku: "MYSTERY-XYZ" }, ACTOR);
    expect(result.ok).toBe(true);
    const rule = await prismaService.ignoreRule.findFirst({
      where: { tenantId, kind: "till_sku", value: "mystery-xyz" },
    });
    expect(rule).not.toBeNull();
    // MYSTERY-XYZ drops out of the queue; the still-unmatched CARRIER-BAG stays.
    const remaining = await queues.getUnmatchedPosSkus(tenantId);
    expect(remaining.map((r) => r.sku)).toEqual(["CARRIER-BAG"]);
  });

  it("lists a live sales gap and clears it once dismissed as a closure", async () => {
    // 07-18 both branches sold; 07-19 only Kilimani → Westlands is a gap.
    await prismaService.salesHistory.createMany({
      data: [
        { tenantId, productId: p1, date: day("2026-07-18"), quantity: 5, revenueKes: 500, channel: "pos", locationId: branchA },
        { tenantId, productId: p2, date: day("2026-07-18"), quantity: 2, revenueKes: 200, channel: "pos", locationId: branchB },
        { tenantId, productId: p1, date: day("2026-07-19"), quantity: 3, revenueKes: 300, channel: "pos", locationId: branchA },
      ],
    });
    const now = new Date("2026-07-20T08:00:00Z");

    const gaps = await queues.getSalesGaps(tenantId, now);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ locationId: branchB, dayKey: "2026-07-19" });

    const dismissed = await match.dismissGapAsClosure(tenantId, { locationId: branchB, dayKey: "2026-07-19" }, ACTOR);
    expect(dismissed.ok).toBe(true);
    const closure = await prismaService.locationClosure.findFirst({ where: { tenantId, locationId: branchB } });
    expect(closure?.reason).toBe("closed");

    expect(await queues.getSalesGaps(tenantId, now)).toHaveLength(0);
  });

  it("Match refuses a SKU with no unmatched lines", async () => {
    await seedPosLines();
    const result = await match.matchPosSku(tenantId, { sku: "NOT-PRESENT", productId: p2 }, ACTOR);
    expect(result).toEqual({ ok: false, reason: "no_lines" });
  });
});
