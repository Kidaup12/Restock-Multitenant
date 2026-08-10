import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { seedDev, type SeedResult } from "../../../packages/db/scripts/seed-dev";
import { getSpikeSuggestions } from "../lib/data/signals";
import { SPIKE_IGNORE_KIND, spikeKey } from "../lib/signals/spikes";

/**
 * An un-logged spike inflates the baseline and every order that follows. The
 * detector for this was written months ago and never called by anything, so the
 * shop was still relying on the owner remembering. These pin the reader that
 * finally asks the question.
 *
 * Skips with no local db.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);
const DAY_MS = 86_400_000;

let seeded: SeedResult;
let tenantId: string;
let productId: string;
let spikeDay: Date;

/** A day key the way the reader formats it. */
const keyOf = (d: Date) => d.toISOString().slice(0, 10);

describe.skipIf(!runnable)("unexplained sales spikes (seeded local db)", () => {
  beforeAll(async () => {
    seeded = await seedDev();
    tenantId = seeded.tenantId;

    const product = await prismaService.product.findFirst({
      where: { tenantId, active: true, notForSale: false, shopifyStatus: "active" },
      select: { id: true },
    });
    productId = product!.id;

    // A flat baseline of 2/day for 40 days, then one day at 30 — comfortably past
    // the detector's 3x multiple and its 8-unit floor.
    const now = new Date();
    await prismaService.salesHistory.deleteMany({ where: { tenantId, productId } });
    for (let i = 1; i <= 40; i++) {
      const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - i * DAY_MS);
      await prismaService.salesHistory.create({
        data: { tenantId, productId, date, quantity: 2, revenueKes: 200, channel: `spike-test-${i}` },
      });
    }
    spikeDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 3 * DAY_MS);
    await prismaService.salesHistory.create({
      data: { tenantId, productId, date: spikeDay, quantity: 30, revenueKes: 3000, channel: "spike-test-day" },
    });
  }, 180_000);

  afterAll(async () => {
    await prismaService.salesHistory.deleteMany({ where: { tenantId, productId } });
    await prismaService.ignoreRule.deleteMany({ where: { tenantId, kind: SPIKE_IGNORE_KIND } });
    await prismaService.promo.deleteMany({ where: { tenantId, notes: "Logged from an unusual sales day" } });
    await prismaService.$disconnect();
  });

  it("asks about a day that sold far above the product's own normal", async () => {
    const spikes = await getSpikeSuggestions(tenantId);
    const mine = spikes.find((s) => s.productId === productId);
    expect(mine, "the seeded 15x day must be raised").toBeDefined();
    expect(mine!.dayKey).toBe(keyOf(spikeDay));
    expect(mine!.quantity).toBe(30);
    expect(mine!.multiple).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it("stops asking once the day is inside a declared promotion", async () => {
    const promo = await prismaService.promo.create({
      data: {
        tenantId,
        startDate: spikeDay,
        endDate: spikeDay,
        scope: "all",
        promoType: "flash",
        notes: "Logged from an unusual sales day",
      },
      select: { id: true },
    });
    try {
      const spikes = await getSpikeSuggestions(tenantId);
      expect(spikes.find((s) => s.productId === productId)).toBeUndefined();
    } finally {
      await prismaService.promo.delete({ where: { id: promo.id } });
    }
  }, 120_000);

  it("stops asking once the owner has answered 'one-off'", async () => {
    // The answer has to outlive the page, or the same question returns on the
    // next load and the owner learns to ignore the card.
    await prismaService.ignoreRule.create({
      data: { tenantId, kind: SPIKE_IGNORE_KIND, value: spikeKey(productId, keyOf(spikeDay)) },
    });
    try {
      const spikes = await getSpikeSuggestions(tenantId);
      expect(spikes.find((s) => s.productId === productId)).toBeUndefined();
    } finally {
      await prismaService.ignoreRule.deleteMany({ where: { tenantId, kind: SPIKE_IGNORE_KIND } });
    }
  }, 120_000);
});
