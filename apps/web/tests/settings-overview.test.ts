import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { seedDev, type SeedResult } from "../../../packages/db/scripts/seed-dev";
import { getSettingsOverview } from "../lib/data/settings-overview";
import { getConnectionStatus } from "../lib/data/connection-status";

/**
 * The Settings hub used to describe what each screen is FOR and say nothing
 * about whether any of it was set up — so "is my store connected?" meant
 * opening six screens. These are the facts the page answers on itself.
 */

const runnable = /localhost|127\.0\.0\.1/.test(process.env.SERVICE_DATABASE_URL ?? "");
let seeded: SeedResult;

describe.skipIf(!runnable)("settings overview (seeded local db)", () => {
  beforeAll(async () => {
    delete process.env.REDIS_URL;
    seeded = await seedDev();
  }, 120_000);

  afterAll(async () => {
    await prismaService.shopifyConnection.deleteMany({ where: { tenantId: seeded.tenantId } });
    await prismaService.$disconnect();
  });

  it("counts what is actually configured, tenant-scoped", async () => {
    const overview = await getSettingsOverview(seeded.tenantId);

    // Cross-checked against the service client, so a query that leaked past the
    // tenant scope shows up as a mismatch rather than a plausible number.
    const [team, locations] = await Promise.all([
      prismaService.membership.count({ where: { tenantId: seeded.tenantId } }),
      prismaService.location.count({ where: { tenantId: seeded.tenantId } }),
    ]);
    expect(overview.teamMembers).toBe(team);
    expect(overview.locations).toBe(locations);
    expect(overview.teamMembers).toBeGreaterThan(0); // vacuity guard
    expect(overview.locations).toBeGreaterThan(0);
  });

  it("reports every way a store can be un-synced, and being synced", async () => {
    await prismaService.shopifyConnection.deleteMany({ where: { tenantId: seeded.tenantId } });
    expect((await getConnectionStatus(seeded.tenantId)).state).toBe("none");

    const conn = await prismaService.shopifyConnection.create({
      data: {
        tenantId: seeded.tenantId,
        shopDomain: `settings-overview-${seeded.tenantId}.myshopify.com`,
        accessToken: "ciphertext",
        scopes: "read_products",
      },
    });
    expect((await getConnectionStatus(seeded.tenantId)).state).toBe("live");

    await prismaService.shopifyConnection.update({
      where: { id: conn.id },
      data: { syncPausedAt: new Date() },
    });
    expect((await getConnectionStatus(seeded.tenantId)).state).toBe("paused");

    // Uninstalled outranks paused — the store is gone, not merely refusing us.
    await prismaService.shopifyConnection.update({
      where: { id: conn.id },
      data: { uninstalledAt: new Date() },
    });
    expect((await getConnectionStatus(seeded.tenantId)).state).toBe("uninstalled");
  });
});
