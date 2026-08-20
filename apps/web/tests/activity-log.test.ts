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

  /**
   * The screen calls itself an accounting record — "who changed a cost", "kept
   * for accounting, entries can't be edited or removed" — and could not answer
   * "which product?". Every line said "a product" or "a record" while the ids
   * sat unread in the same rows the operator console renders in full.
   */
  describe("naming the record", () => {
    it("names the product whose cost changed, with its SKU", async () => {
      const product = await prismaService.product.findFirst({
        where: { tenantId: seeded.tenantId },
        select: { id: true, title: true, sku: true },
      });
      const row = await prismaService.auditEvent.create({
        data: {
          tenantId: seeded.tenantId,
          entity: "Product",
          entityId: product!.id,
          action: "cost_changed",
          actorName: "The owner",
          meta: { from: 100, to: 200, field: "costKes" },
        },
      });
      try {
        const entries = await getActivity(seeded.tenantId, { canViewCosts: true, currency: "KES" });
        const named = entries.find((e) => e.id === row.id)!;
        expect(named.summary).toContain(product!.title);
        expect(named.summary).toContain(product!.sku);
        // ...and still carries the money it always did.
        expect(named.summary).toContain("KES 200");
      } finally {
        await prismaService.auditEvent.delete({ where: { id: row.id } });
      }
    });

    it("falls back to the generic noun for a record that no longer exists", async () => {
      // Reading a log to find out what was deleted is the commonest reason to
      // open one, so an unresolvable id must degrade, never blank the entry.
      const row = await prismaService.auditEvent.create({
        data: {
          tenantId: seeded.tenantId,
          entity: "Supplier",
          entityId: "supplier-that-was-deleted",
          action: "deleted",
          actorName: "The owner",
        },
      });
      try {
        const entries = await getActivity(seeded.tenantId, { canViewCosts: true, currency: "KES" });
        const entry = entries.find((e) => e.id === row.id)!;
        expect(entry.summary).toBe("Deleted a supplier");
      } finally {
        await prismaService.auditEvent.delete({ where: { id: row.id } });
      }
    });

    it("never resolves a name from another workspace", async () => {
      // The lookup runs on the tenant-scoped client. An audit row pointing at a
      // foreign id must read as the generic noun, not as that shop's product.
      const other = await prismaService.tenant.create({
        data: { name: "Other Shop", slug: `activity-other-${Date.now()}` },
      });
      const foreign = await prismaService.product.create({
        data: {
          tenantId: other.id,
          sku: "FOREIGN-SKU",
          title: "Another Shop's Secret Product",
          costKes: 1,
          priceKes: 2,
        },
      });
      const row = await prismaService.auditEvent.create({
        data: {
          tenantId: seeded.tenantId,
          entity: "Product",
          entityId: foreign.id,
          action: "edited",
          actorName: "The owner",
        },
      });
      try {
        const entries = await getActivity(seeded.tenantId, { canViewCosts: true, currency: "KES" });
        const entry = entries.find((e) => e.id === row.id)!;
        expect(entry.summary).toBe("Edited a product");
        expect(JSON.stringify(entries)).not.toContain("Another Shop's Secret Product");
        expect(JSON.stringify(entries)).not.toContain("FOREIGN-SKU");
      } finally {
        await prismaService.auditEvent.delete({ where: { id: row.id } });
        await prismaService.tenant.delete({ where: { id: other.id } });
      }
    });

    it("says plainly when support opened the workspace", async () => {
      // These rows are written against the CUSTOMER's tenant, so they land in
      // the shop's own log — which is right for an accounting trail. They read
      // "impersonation start — a record", which tells a shop nothing.
      const row = await prismaService.auditEvent.create({
        data: {
          tenantId: seeded.tenantId,
          entity: "AdminSession",
          entityId: "sess-1",
          action: "impersonation_start",
          actorName: "An operator",
        },
      });
      try {
        const entries = await getActivity(seeded.tenantId, { canViewCosts: true, currency: "KES" });
        const entry = entries.find((e) => e.id === row.id)!;
        expect(entry.summary).toBe("Wezesha support opened this workspace");
        expect(entry.summary).not.toContain("impersonation");
        expect(entry.summary).not.toContain("a record");
      } finally {
        await prismaService.auditEvent.delete({ where: { id: row.id } });
      }
    });

    it("leaves no production entity reading as 'a record'", async () => {
      // Every entity the app writes, taken from a census of the live ledger.
      const entities = [
        "PurchaseOrder", "Product", "Supplier", "ShopifyConnection", "Tenant",
        "TenantConfig", "Location", "LocationClosure", "DistributionPlan",
        "Promo", "Membership",
      ];
      const rows = await prismaService.auditEvent.createManyAndReturn({
        data: entities.map((entity) => ({
          tenantId: seeded.tenantId,
          entity,
          entityId: `census-${entity}`,
          action: "created",
          actorName: "The owner",
        })),
      });
      try {
        const entries = await getActivity(seeded.tenantId, { canViewCosts: true, currency: "KES" });
        for (const row of rows) {
          const entry = entries.find((e) => e.id === row.id)!;
          expect(entry.summary, row.entity).not.toContain("a record");
        }
      } finally {
        await prismaService.auditEvent.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
      }
    });
  });
});
