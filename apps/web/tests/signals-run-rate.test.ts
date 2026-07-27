import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The point of the feature, proven end to end: a promo declared through the
 * Settings action over a past date range takes those days out of the run rate
 * the forecast computes. A spike is injected into one product's recent history,
 * the forecast is re-run before and after declaring the promo, and the baseline
 * layer (layer1Forecast30d — the run-rate layer) is compared.
 *
 * Session + revalidation are stubbed; seed, database and forecast are real.
 * Skips without a local service connection.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const authState = vi.hoisted(() => ({
  session: null as { user: { id: string; name: string | null; email: string } } | null,
  membership: null as
    | { tenantId: string; displayName: string | null; role: string; permissions: unknown }
    | null,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({
  requireSession: async () => authState.session,
  activeMembership: async () => authState.membership,
}));

import { prismaService } from "@wezesha/db";
import { seedDev, type SeedResult } from "../../../packages/db/scripts/seed-dev";
import { declarePromo } from "../app/(shell)/settings/signals/actions";
import { runForecast } from "../lib/forecast-run/run";

/** How hard the injected promo spike hits: unmistakable against seed noise. */
const SPIKE_MULTIPLE = 20;
const SPIKE_DAYS = 5;

let seeded: SeedResult;

async function baselineFor(tenantId: string, productId: string): Promise<number> {
  await runForecast(tenantId);
  const prediction = await prismaService.prediction.findFirstOrThrow({
    where: { tenantId, productId },
    select: { layer1Forecast30d: true },
  });
  return prediction.layer1Forecast30d;
}

describe.skipIf(!runnable)("declared promo vs the run rate (seeded local db)", () => {
  beforeAll(async () => {
    delete process.env.REDIS_URL; // the realtime publish degrades to a no-op
    seeded = await seedDev();
  }, 120_000);

  afterAll(async () => {
    await prismaService.$disconnect();
  });

  it("drops the declared days out of the baseline the forecast works from", async () => {
    // A steady seller: enough history that a spike is visibly abnormal.
    const busiest = await prismaService.salesHistory.groupBy({
      by: ["productId"],
      where: { tenantId: seeded.tenantId },
      _sum: { quantity: true },
      orderBy: { _sum: { quantity: "desc" } },
      take: 1,
    });
    const productId = busiest[0]!.productId;
    const product = await prismaService.product.findUniqueOrThrow({
      where: { id: productId },
      select: { sku: true },
    });

    const before = await baselineFor(seeded.tenantId, productId);
    expect(before).toBeGreaterThan(0);

    // Inflate the most recent days the way a giveaway would.
    const recent = await prismaService.salesHistory.findMany({
      where: { tenantId: seeded.tenantId, productId },
      orderBy: { date: "desc" },
      take: SPIKE_DAYS,
      select: { id: true, date: true },
    });
    expect(recent).toHaveLength(SPIKE_DAYS);
    await prismaService.salesHistory.updateMany({
      where: { id: { in: recent.map((r) => r.id) } },
      data: { quantity: { multiply: SPIKE_MULTIPLE } },
    });

    const spiked = await baselineFor(seeded.tenantId, productId);
    expect(spiked).toBeGreaterThan(before);

    // Declare the spike as a promo, through the real server action.
    const days = recent.map((r) => r.date.toISOString().slice(0, 10)).sort();
    authState.session = {
      user: { id: seeded.userId, name: "Owner One", email: "owner@example.test" },
    };
    authState.membership = {
      tenantId: seeded.tenantId,
      displayName: "Owner One",
      role: "OWNER",
      permissions: null,
    };
    const declared = await declarePromo({
      startDate: days[0]!,
      endDate: days[days.length - 1]!,
      scope: "sku",
      scopeValue: product.sku,
      promoType: "giveaway",
      notes: "Injected spike",
    });
    expect(declared.ok).toBe(true);

    const afterDeclaring = await baselineFor(seeded.tenantId, productId);
    // The spike no longer counts, so the baseline falls back towards where it
    // was before the promo days existed.
    expect(afterDeclaring).toBeLessThan(spiked);
    expect(Math.abs(afterDeclaring - before)).toBeLessThan(Math.abs(spiked - before));
  }, 120_000);
});
