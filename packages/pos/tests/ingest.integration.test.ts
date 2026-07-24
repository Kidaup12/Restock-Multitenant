import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { ingestPosSales } from "../src/ingest";
import type { PosSaleInput } from "../src/types";

/**
 * Ingest against a real database, on an isolated tenant shaped like the
 * amara-beauty dev seed (real beauty SKUs, a Nairobi branch + a warehouse map).
 * Proves the DB-level contract the pure planner can't: set-semantics idempotency,
 * IgnoreRule application, warehouse→location attribution, and the tenant-timezone
 * day boundary end to end. FAILs (not skips) off a local DB — a silent skip
 * would hide a broken writer.
 */

const local = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "");
const SLUG = "pos-itest";

let tenantId: string;
let kilimaniId: string;
let cantuId: string;
let glyId: string;

/** The synthetic till window: two physical receipts (one late-evening), an
 *  unmatched code, a junk code, and one online receipt that must be excluded. */
function payload(): PosSaleInput[] {
  return [
    {
      externalId: "T1",
      date: "2026-07-15 10:00:00",
      warehouse: "Kilimani",
      createdBy: "Grace",
      lines: [
        { sku: "CAN-SHE-340", qty: 2, subtotal: 3300 },
        { sku: "MYSTERY-XYZ", qty: 1, subtotal: 90 },
      ],
    },
    {
      externalId: "T2",
      date: "2026-07-15 19:30:00",
      warehouse: "Kilimani",
      createdBy: "Grace",
      lines: [
        { sku: "CAN-SHE-340", qty: 1 }, // no price → catalogue fallback (1650)
        { sku: "CARRIER-BAG", qty: 2, subtotal: 40 },
      ],
    },
    {
      externalId: "T3",
      date: "2026-07-15 23:30:00", // 20:30 UTC — still the 15th in Nairobi
      warehouse: "Kilimani",
      createdBy: "Grace",
      lines: [{ sku: "CAN-SHE-340", qty: 1, subtotal: 1650 }],
    },
    {
      externalId: "WEB1",
      date: "2026-07-15 12:00:00",
      channel: "shopify",
      createdBy: "SHOPIFY",
      lines: [{ sku: "CAN-SHE-340", qty: 5, subtotal: 8250 }],
    },
  ];
}

beforeAll(async () => {
  expect(local, "pos ingest integration must run against a local database").toBe(true);
  await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
  const tenant = await prismaService.tenant.create({
    data: { name: "POS Itest", slug: SLUG, timezone: "Africa/Nairobi" },
  });
  tenantId = tenant.id;
  const cantu = await prismaService.product.create({
    data: { tenantId, sku: "CAN-SHE-340", title: "Cantu Shea Butter Leave-In 340g", priceKes: 1650 },
  });
  cantuId = cantu.id;
  const gly = await prismaService.product.create({
    data: { tenantId, sku: "NL-GLY-750", title: "Nice & Lovely Pure Glycerine 750ml", priceKes: 450 },
  });
  glyId = gly.id;
  const kilimani = await prismaService.location.create({
    data: { tenantId, name: "Kilimani Shop", locationType: "branch", roleStatus: "confirmed", isPrimary: true },
  });
  kilimaniId = kilimani.id;
  await prismaService.warehouseLocationMap.create({
    data: { tenantId, warehouseName: "Kilimani", locationId: kilimani.id },
  });
});

afterAll(async () => {
  if (tenantId) await prismaService.tenant.delete({ where: { id: tenantId } });
  await prismaService.$disconnect();
});

beforeEach(async () => {
  // Fresh POS state per test; catalogue + mapping persist.
  await prismaService.posSale.deleteMany({ where: { tenantId } });
  await prismaService.salesHistory.deleteMany({ where: { tenantId, channel: "pos" } });
  await prismaService.ignoreRule.deleteMany({ where: { tenantId } });
});

describe("ingestPosSales", () => {
  it("stores raw sales + lines, derives SalesHistory, excludes online, keeps unmatched", async () => {
    const res = await ingestPosSales({ tenantId, sales: payload() });
    expect(res).not.toBeNull();
    expect(res!.salesIngested).toBe(3);
    expect(res!.salesExcluded).toBe(1);
    expect(res!.linesMatched).toBe(3);
    expect(res!.linesUnmatched).toBe(2); // MYSTERY-XYZ + CARRIER-BAG (no rule yet)

    const sales = await prismaService.posSale.count({ where: { tenantId } });
    const lines = await prismaService.posSaleLine.count({ where: { tenantId } });
    expect(sales).toBe(3);
    expect(lines).toBe(5);

    const unmatchedLines = await prismaService.posSaleLine.count({
      where: { tenantId, productId: null },
    });
    expect(unmatchedLines).toBe(2);

    // Derived SalesHistory: one row, the whole trading day on the 15th (the
    // 23:30 Nairobi sale did NOT spill onto the 16th), attributed to Kilimani.
    const sh = await prismaService.salesHistory.findMany({ where: { tenantId, channel: "pos" } });
    expect(sh).toHaveLength(1);
    expect(sh[0]!.productId).toBe(cantuId);
    expect(sh[0]!.date.toISOString().slice(0, 10)).toBe("2026-07-15");
    expect(sh[0]!.quantity).toBe(4);
    expect(sh[0]!.revenueKes).toBe(6600); // 3300 + 1650(fallback) + 1650
    expect(sh[0]!.locationId).toBe(kilimaniId);
  });

  it("is idempotent: replaying the same window overwrites, never doubles", async () => {
    await ingestPosSales({ tenantId, sales: payload() });
    await ingestPosSales({ tenantId, sales: payload() });

    expect(await prismaService.posSale.count({ where: { tenantId } })).toBe(3);
    expect(await prismaService.posSaleLine.count({ where: { tenantId } })).toBe(5);
    const sh = await prismaService.salesHistory.findMany({ where: { tenantId, channel: "pos" } });
    expect(sh).toHaveLength(1);
    expect(sh[0]!.quantity).toBe(4); // not 8
    expect(sh[0]!.revenueKes).toBe(6600);
  });

  it("applies an IgnoreRule: the junk SKU stops counting as unmatched and stays out of SalesHistory", async () => {
    await prismaService.ignoreRule.create({
      data: { tenantId, kind: "till_sku", value: "CARRIER-BAG" },
    });
    const res = await ingestPosSales({ tenantId, sales: payload() });
    expect(res!.linesIgnored).toBe(1);
    expect(res!.linesUnmatched).toBe(1); // only MYSTERY-XYZ now
    // Raw line still stored (the sale happened), but with no product link.
    const bagLine = await prismaService.posSaleLine.findFirst({
      where: { tenantId, sku: "CARRIER-BAG" },
    });
    expect(bagLine).not.toBeNull();
    expect(bagLine!.productId).toBeNull();
    // SalesHistory is unchanged (the junk SKU never contributed).
    const sh = await prismaService.salesHistory.findMany({ where: { tenantId, channel: "pos" } });
    expect(sh).toHaveLength(1);
    expect(sh[0]!.quantity).toBe(4);
  });

  it("re-applies a human match on the next re-pull (learned alias survives set-semantics)", async () => {
    await ingestPosSales({ tenantId, sales: payload() });
    // Simulate the Match action: link the till code MYSTERY-XYZ to a product.
    await prismaService.posSaleLine.updateMany({
      where: { tenantId, sku: "MYSTERY-XYZ" },
      data: { productId: glyId },
    });

    // The feed re-pulls the same window (which recreates the raw lines).
    const res = await ingestPosSales({ tenantId, sales: payload() });
    // MYSTERY-XYZ is no longer unmatched — the learned link re-applied.
    expect(res!.linesUnmatched).toBe(1); // only CARRIER-BAG remains unmatched
    const relinked = await prismaService.posSaleLine.findFirst({
      where: { tenantId, sku: "MYSTERY-XYZ" },
    });
    expect(relinked!.productId).toBe(glyId);
    // Its sale now feeds the product's POS run rate.
    const sh = await prismaService.salesHistory.findFirst({
      where: { tenantId, productId: glyId, channel: "pos" },
    });
    expect(sh?.quantity).toBe(1);
  });

  it("shrinks a day's totals when the same window is re-pulled with fewer units (overwrite, not append)", async () => {
    await ingestPosSales({ tenantId, sales: payload() });
    // The same window re-pulled, but T1's Cantu quantity was corrected 2 → 1.
    const corrected = payload();
    corrected[0]!.lines[0] = { sku: "CAN-SHE-340", qty: 1, subtotal: 1650 };
    await ingestPosSales({ tenantId, sales: corrected });

    const sh = await prismaService.salesHistory.findMany({ where: { tenantId, channel: "pos" } });
    expect(sh).toHaveLength(1);
    expect(sh[0]!.quantity).toBe(3); // 1 + 1 + 1, down from 4 — the day shrank
    expect(sh[0]!.revenueKes).toBe(4950); // 1650 × 3
    expect(await prismaService.posSale.count({ where: { tenantId } })).toBe(3); // no duplicate sales
  });
});
