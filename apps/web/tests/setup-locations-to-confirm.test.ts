import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { setupDepth } from "../lib/capabilities/setup-depth";

/**
 * Asking the shop to confirm what each location is FOR.
 *
 * The Shopify sync guesses a location's role from its name and marks the guess
 * `assumed`. That role decides which stock counts as sellable —
 * `Product.currentStock` is the branch-only rollup — so a shopfront guessed as
 * a store room hides its stock from the forecast, and a store room guessed as a
 * shopfront has the buy list counting stock nobody can sell.
 *
 * The single-location case is the one that bites hardest: guessed wrong, NOTHING
 * is sellable and the buy list asks the shop to reorder its whole catalogue. So
 * an unconfirmed location counts even when there is only one.
 *
 * Every location on every live workspace is currently an unconfirmed guess,
 * which is why this is surfaced in onboarding rather than left in settings.
 *
 * Skips with no local db.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);
const SLUG = "setup-locations-tenant";

describe.skipIf(!runnable)("locations awaiting confirmation (local db)", () => {
  let tenantId: string;

  const location = (name: string, roleStatus: string | null, locationType: string | null) =>
    prismaService.location.create({
      data: { tenantId, name, roleStatus, locationType, source: "shopify" },
    });

  beforeAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    tenantId = (await prismaService.tenant.create({
      data: { name: "Setup Locations Co", slug: SLUG },
    })).id;
  });

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { id: tenantId } });
    await prismaService.$disconnect();
  });

  it("counts nothing to confirm when a workspace has no locations", async () => {
    expect((await setupDepth(tenantId)).locationsToConfirm).toBe(0);
  });

  it("counts a single guessed location — the case that hides an entire catalogue", async () => {
    await location("Main Store Room", "assumed", "warehouse");
    expect((await setupDepth(tenantId)).locationsToConfirm).toBe(1);
  });

  it("counts every guess, not just the first", async () => {
    await location("Kilimani Flagship", "assumed", "branch");
    await location("Industrial Area", "assumed", "warehouse");
    expect((await setupDepth(tenantId)).locationsToConfirm).toBe(3);
  });

  it("stops counting one the shop has confirmed", async () => {
    await prismaService.location.updateMany({
      where: { tenantId, name: "Kilimani Flagship" },
      data: { roleStatus: "confirmed" },
    });
    expect((await setupDepth(tenantId)).locationsToConfirm).toBe(2);
  });

  it("treats a null role status as an unanswered guess, not as confirmed", async () => {
    // The sync only stamps `assumed` when it guesses; a row predating that, or
    // one written by another path, must not read as settled.
    await location("Nowhere In Particular", null, null);
    expect((await setupDepth(tenantId)).locationsToConfirm).toBe(3);
  });

  it("is clear once every location has been confirmed", async () => {
    await prismaService.location.updateMany({
      where: { tenantId },
      data: { roleStatus: "confirmed" },
    });
    expect((await setupDepth(tenantId)).locationsToConfirm).toBe(0);
  });

  it("does not disturb the capability ladder — it unlocks nothing", async () => {
    // Confirming a role is a correctness check, not a rung. A workspace with
    // nothing else set up must stay at level 0 either way.
    const depth = await setupDepth(tenantId);
    expect(depth.level).toBe(0);
    expect(depth.nextUnlock?.signal).toBe("shopify");
  });
});
