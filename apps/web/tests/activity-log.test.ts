import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { seedDev, type SeedResult } from "../../../packages/db/scripts/seed-dev";
import { getActivity } from "../lib/data/activity";

/**
 * The shop's own audit trail. The rows were always written and only ever
 * readable in the operator console.
 *
 * The trap: a cost change stores the actual figures in `meta`
 * (`{from: 500, to: 650}`). Shipping raw meta — or even the fact that a cost
 * moved — hands a money-blind member a cost figure, the same leak-by-derivation
 * that `plannable` and the cost-moved flag are guarded against.
 */

const runnable = /localhost|127\.0\.0\.1/.test(process.env.SERVICE_DATABASE_URL ?? "");
let seeded: SeedResult;

describe.skipIf(!runnable)("activity log (seeded local db)", () => {
  beforeAll(async () => {
    delete process.env.REDIS_URL;
    seeded = await seedDev();
    await prismaService.auditEvent.createMany({
      data: [
        {
          tenantId: seeded.tenantId,
          entity: "Product",
          entityId: "p1",
          action: "cost_changed",
          actorName: "The owner",
          meta: { from: 500, to: 650, field: "costKes" },
        },
        {
          tenantId: seeded.tenantId,
          entity: "PurchaseOrder",
          entityId: "po1",
          action: "cancelled",
          actorName: "The owner",
        },
      ],
    });
  }, 120_000);

  afterAll(async () => {
    await prismaService.auditEvent.deleteMany({ where: { tenantId: seeded.tenantId } });
    await prismaService.$disconnect();
  });

  it("tells an owner what changed, in money they can read", async () => {
    const entries = await getActivity(seeded.tenantId, { canViewCosts: true, currency: "KES" });
    const cost = entries.find((e) => e.summary.startsWith("Changed the cost"));
    expect(cost).toBeDefined();
    expect(cost!.summary).toContain("KES 500");
    expect(cost!.summary).toContain("KES 650");
    expect(cost!.actor).toBe("The owner");
  });

  it("gives a money-blind member no cost entry at all", async () => {
    const entries = await getActivity(seeded.tenantId, { canViewCosts: false, currency: "KES" });
    // Not merely redacted — absent. The entry's presence is itself the fact
    // that a cost moved.
    expect(entries.some((e) => e.summary.toLowerCase().includes("cost"))).toBe(false);
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain("500");
    expect(serialized).not.toContain("650");

    // The operational record still reaches them.
    expect(entries.some((e) => e.summary.includes("Cancelled"))).toBe(true);
  });

  it("never ships raw meta to either role", async () => {
    for (const canViewCosts of [true, false]) {
      const entries = await getActivity(seeded.tenantId, { canViewCosts, currency: "KES" });
      const serialized = JSON.stringify(entries);
      expect(serialized, String(canViewCosts)).not.toContain("costKes");
      expect(serialized, String(canViewCosts)).not.toContain('"meta"');
    }
  });

  it("renders an action nobody wrote copy for, rather than dropping it", async () => {
    await prismaService.auditEvent.create({
      data: {
        tenantId: seeded.tenantId,
        entity: "Widget",
        entityId: "w1",
        action: "frobnicated_twice",
        actorName: "The owner",
      },
    });
    const entries = await getActivity(seeded.tenantId, { canViewCosts: true, currency: "KES" });
    const unknown = entries.find((e) => e.summary.includes("frobnicated twice"));
    expect(unknown).toBeDefined();
    expect(unknown!.summary).not.toContain("_"); // the token never shows raw
  });
});
