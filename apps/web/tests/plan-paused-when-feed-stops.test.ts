import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { runForecast, tenantIngestVerdict } from "@wezesha/forecast-run";
import { seedDev, type SeedResult } from "../../../packages/db/scripts/seed-dev";

/**
 * The buy list must say the forecast is PAUSED, not that none has been run.
 *
 * A dev store stopped receiving orders on 6 August; on 31 August the planner
 * still read "No forecast yet — Run the forecast", and the button silently did
 * nothing, because the run refuses while the feed looks stopped. A merchant
 * presses that twice and concludes the product is broken.
 *
 * What is asserted here is not the wording but the thing the wording depends
 * on: the verdict the PAGE reads is the same verdict the RUN gates on. Two
 * separate staleness rules would agree on most days and diverge on exactly the
 * day someone is looking at an empty buy list.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);


describe.skipIf(!runnable)("a stopped sales feed pauses the buy list (seeded local db)", () => {
  let seeded: SeedResult;

  beforeAll(async () => {
    seeded = await seedDev();
  }, 120_000);

  afterAll(async () => {
    await prismaService.$disconnect();
  });

  it("does not pause on a healthy feed, and the run produces a forecast", async () => {
    const verdict = await tenantIngestVerdict(seeded.tenantId);
    expect(verdict.stop, verdict.reasons.join(" ")).toBe(false);

    const run = await runForecast(seeded.tenantId);
    expect(run.created).toBe(seeded.productCount);
  });

  it("pauses once the newest sale is older than the gate allows, and the run agrees", async () => {
    // Push every sale far enough back that the newest COMPLETED day is well
    // past the threshold — the shape of the dev store on 31 August.
    await prismaService.$executeRawUnsafe(
      `UPDATE "SalesHistory" SET "date" = "date" - INTERVAL '20 days' WHERE "tenantId" = $1`,
      seeded.tenantId,
    );

    const verdict = await tenantIngestVerdict(seeded.tenantId);
    expect(verdict.stop, "the page would still offer a Run forecast button").toBe(true);
    expect(verdict.reasons.join(" "), "the page has nothing to tell the shop").not.toBe("");

    // The run reaches the same conclusion — one rule, not two that agree today.
    const run = await runForecast(seeded.tenantId);
    expect(run.created).toBe(0);
    expect((run as { skipped?: string }).skipped).toBe("ingest_stale");
  });
});
