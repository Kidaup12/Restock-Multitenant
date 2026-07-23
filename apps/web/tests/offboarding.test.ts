import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, prismaService } from "@wezesha/db";
import { EXPORTED_MODELS, exportTenantJson } from "../lib/offboarding/export";
import { deleteTenant } from "../lib/offboarding/delete";

/**
 * Offboarding against the local database, PER THE PRODUCTION-SAFETY RULE with
 * fixture tenants this suite creates and destroys itself — never a seeded dev
 * tenant, never anything real. Covers: export completeness + isolation +
 * token omission, and every delete safeguard before the cascade.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const SLUG_A = "offboard-test-a";
const SLUG_B = "offboard-test-b";
const ACTOR = { userId: "offboard-test-user", name: "Offboard Tester" };

describe("export manifest census", () => {
  it("every tenantId model in the schema is in EXPORTED_MODELS", () => {
    const tenantModels = Prisma.dmmf.datamodel.models
      .filter((model) => model.fields.some((field) => field.name === "tenantId"))
      .map((model) => model.name)
      .sort();
    const exported = EXPORTED_MODELS.map((entry) => entry.model).sort();
    expect(exported).toEqual(tenantModels);
  });
});

describe.skipIf(!runnable)("tenant export + delete (local db, fixture tenants)", () => {
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
    const a = await prismaService.tenant.create({
      data: { name: "Offboard A", slug: SLUG_A },
    });
    const b = await prismaService.tenant.create({
      data: { name: "Offboard B", slug: SLUG_B },
    });
    tenantA = a.id;
    tenantB = b.id;

    await prismaService.product.createMany({
      data: [
        { tenantId: tenantA, sku: "OFF-A-1", title: "Baobab Oil 50ml" },
        { tenantId: tenantA, sku: "OFF-A-2", title: "Neem Balm 30g" },
        { tenantId: tenantB, sku: "OFF-B-1", title: "Never In A's Export" },
      ],
    });
    await prismaService.supplier.create({
      data: { tenantId: tenantA, name: "Offboard Supplier" },
    });
    await prismaService.notification.create({
      data: { tenantId: tenantA, kind: "sync_failed", title: "old failure" },
    });
    await prismaService.shopifyConnection.create({
      data: {
        tenantId: tenantA,
        shopDomain: "offboard-test-a.myshopify.com",
        accessToken: "encrypted-ciphertext-never-exported",
        scopes: "read_products",
      },
    });
    await prismaService.backtestRun.create({
      data: { tenantId: tenantB, mae: 1, bias: 0, sampleSize: 5 },
    });
  });

  afterAll(async () => {
    await prismaService.backtestRun.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
    await prismaService.auditEvent.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
    await prismaService.tenant.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
    await prismaService.$disconnect();
  });

  it("exports the tenant's rows — and only the tenant's rows", async () => {
    const json = await exportTenantJson(tenantA, ACTOR);
    const parsed = JSON.parse(json) as {
      format: string;
      tenant: { id: string; slug: string };
      tables: Record<string, Array<Record<string, unknown>>>;
    };

    expect(parsed.format).toBe("wezesha-tenant-export");
    expect(parsed.tenant.id).toBe(tenantA);
    expect(parsed.tenant.slug).toBe(SLUG_A);

    const skus = parsed.tables.Product!.map((p) => p.sku).sort();
    expect(skus).toEqual(["OFF-A-1", "OFF-A-2"]); // B's product must not leak in
    expect(parsed.tables.Supplier!.length).toBe(1);
    expect(parsed.tables.Notification!.length).toBe(1);
    // Every manifest table appears, even when empty.
    for (const { model } of EXPORTED_MODELS) {
      expect(parsed.tables[model], `table ${model} missing`).toBeDefined();
    }
  });

  it("omits the Shopify token ciphertext from the export", async () => {
    const json = await exportTenantJson(tenantA, ACTOR);
    expect(json).not.toContain("encrypted-ciphertext-never-exported");
    const parsed = JSON.parse(json) as {
      tables: { ShopifyConnection: Array<Record<string, unknown>> };
    };
    expect(parsed.tables.ShopifyConnection.length).toBe(1);
    expect(parsed.tables.ShopifyConnection[0]).not.toHaveProperty("accessToken");
    expect(parsed.tables.ShopifyConnection[0]!.shopDomain).toBe("offboard-test-a.myshopify.com");
  });

  it("writes the 'exported' ledger entry a later delete can verify", async () => {
    const events = await prismaService.auditEvent.findMany({
      where: { tenantId: tenantA, entity: "Tenant", action: "exported" },
    });
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.actorUserId).toBe(ACTOR.userId);
  });

  it("rejects a wrong slug confirmation", async () => {
    const result = await deleteTenant({
      tenantId: tenantB,
      confirmSlug: "not-the-slug",
      exportConfirmed: true,
      actorUserId: ACTOR.userId,
      actorName: ACTOR.name,
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it("rejects when the export checkbox is not confirmed", async () => {
    const result = await deleteTenant({
      tenantId: tenantB,
      confirmSlug: SLUG_B,
      exportConfirmed: false,
      actorUserId: ACTOR.userId,
      actorName: ACTOR.name,
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it("rejects when no fresh export exists in the ledger", async () => {
    const result = await deleteTenant({
      tenantId: tenantB,
      confirmSlug: SLUG_B,
      exportConfirmed: true,
      actorUserId: ACTOR.userId,
      actorName: ACTOR.name,
    });
    expect(result).toMatchObject({ ok: false, status: 409 });
    // Safeguard proof: the tenant is still there.
    const still = await prismaService.tenant.findMany({ where: { id: tenantB } });
    expect(still.length).toBe(1);
  });

  it("deletes after export: cascade + non-FK cleanup, ledger survives", async () => {
    await exportTenantJson(tenantB, ACTOR);

    const result = await deleteTenant({
      tenantId: tenantB,
      confirmSlug: SLUG_B,
      exportConfirmed: true,
      actorUserId: ACTOR.userId,
      actorName: ACTOR.name,
    });
    expect(result).toEqual({ ok: true });

    expect(await prismaService.tenant.findMany({ where: { id: tenantB } })).toEqual([]);
    expect(await prismaService.product.count({ where: { tenantId: tenantB } })).toBe(0);
    expect(await prismaService.backtestRun.count({ where: { tenantId: tenantB } })).toBe(0);

    // The obituary outlives the tenant.
    const deleted = await prismaService.auditEvent.findMany({
      where: { tenantId: tenantB, entity: "Tenant", action: "deleted" },
    });
    expect(deleted.length).toBe(1);
    expect(deleted[0]!.meta).toMatchObject({ slug: SLUG_B });

    // The other workspace is untouched.
    expect(await prismaService.product.count({ where: { tenantId: tenantA } })).toBe(2);
  });
});
