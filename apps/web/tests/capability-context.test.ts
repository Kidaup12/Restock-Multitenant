import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { planAllows, resolveCapability, resolveCapabilityContext } from "../lib/capabilities";

/**
 * The capability context resolved against the seeded amara-beauty tenant on the
 * real RLS-scoped client — the data-layer proof that setup depth, feature
 * switches, plan, and limits all read correctly and compose into a gate result.
 * Skips when no local database is configured.
 *
 * The seed omits a ShopifyConnection, so this test adds one (and removes it in
 * teardown) to read the tenant as connected — everything else is genuine seed
 * data: manual costs on every product, a supplier on every product, and a
 * single selling branch alongside a warehouse.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const TEST_SHOP_DOMAIN = "amara-beauty-cap-test.myshopify.com";

describe.skipIf(!runnable)("resolveCapabilityContext (seeded amara-beauty)", () => {
  let tenantId: string;

  beforeAll(async () => {
    const tenant = await prismaService.tenant.findUnique({
      where: { slug: "amara-beauty" },
      select: { id: true },
    });
    if (!tenant) throw new Error("amara-beauty is not seeded — run scripts/seed-dev.ts");
    tenantId = tenant.id;

    // Read the tenant as Shopify-connected for this suite (seed leaves it out).
    await prismaService.shopifyConnection.deleteMany({ where: { tenantId } });
    await prismaService.shopifyConnection.create({
      data: {
        tenantId,
        shopDomain: TEST_SHOP_DOMAIN,
        accessToken: "test-token",
        scopes: "read_products",
      },
    });
  });

  afterAll(async () => {
    await prismaService.shopifyConnection.deleteMany({ where: { tenantId } });
    await prismaService.$disconnect();
  });

  it("resolves the four-gate context from real tenant data", async () => {
    const ctx = await resolveCapabilityContext(tenantId, { role: "OWNER", permissions: null });

    expect(ctx.plan).toBe("growth"); // the seed puts the demo tenant on Growth
    expect(ctx.setup.signals).toEqual({
      shopify: true, // connection added above + a full catalogue
      costs: true, // every seeded product carries a manual cost
      suppliers: true, // every product has a supplier assigned
      posOrMultiLocation: false, // one branch, no POS feed
    });
    expect(ctx.setup.level).toBe(2);
    expect(ctx.setup.nextUnlock?.signal).toBe("posOrMultiLocation");
    expect(ctx.limits.products.used).toBe(30);
  });

  it("gates capabilities against that context", async () => {
    const ctx = await resolveCapabilityContext(tenantId, { role: "OWNER", permissions: null });

    // Owner, costs present (level 2 ≥ 1): both baseline capabilities open.
    expect(resolveCapability(ctx, "run_forecast").available).toBe(true);
    expect(resolveCapability(ctx, "view_costs").available).toBe(true);

    // Growth includes the paid features a demo has to show: the budget planner
    // on /plan, insights, and the PO email that suppliers at level 2 unlock.
    expect(resolveCapability(ctx, "budget_planner").available).toBe(true);
    expect(resolveCapability(ctx, "email_po_to_supplier").available).toBe(true);
    expect(planAllows(ctx.plan, "insights")).toBe(true);

    // Transfers is Growth-tier too, so the plan no longer blocks it — what's
    // missing is depth: one selling branch and no POS feed (needs level 3).
    expect(resolveCapability(ctx, "transfers").blockedGate).toBe("setup");
  });

  it("keeps a money-blind member out of costs by role", async () => {
    const ctx = await resolveCapabilityContext(tenantId, { role: "MEMBER", permissions: null });
    const res = resolveCapability(ctx, "view_costs");
    expect(res.available).toBe(false);
    expect(res.blockedGate).toBe("role");
  });
});
