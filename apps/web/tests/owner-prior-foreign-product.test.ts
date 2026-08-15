import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { createOwnerPrior } from "@wezesha/forecast-run";

/**
 * A prior names products by id, and both ids come from the request body of
 * POST /api/forecast/priors: the scope value on a product-scoped prior, and the
 * "sell like" proxy.
 *
 * OwnerPrior carries no foreign key on either, and RLS scopes rows, not the
 * rows a new row points at — on a create there is no pre-existing row for it to
 * filter. So a scoped read of the product is the only guard, and these assert
 * it fires for both fields.
 *
 * Skips with no local db.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const SLUG_A = "prior-fk-a";
const SLUG_B = "prior-fk-b";

describe.skipIf(!runnable)("owner prior naming a foreign product (local db)", () => {
  let tenantA: string;
  let ownProduct: string;
  let foreignProduct: string;

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
    await prismaService.$disconnect();
  });

  beforeEach(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
    const a = await prismaService.tenant.create({
      data: { name: "Prior A", slug: SLUG_A, currency: "KES" },
    });
    const b = await prismaService.tenant.create({
      data: { name: "Prior B", slug: SLUG_B, currency: "KES" },
    });
    tenantA = a.id;
    const own = await prismaService.product.create({
      data: { tenantId: a.id, sku: "PA-1", title: "A's product", vendor: "House" },
    });
    ownProduct = own.id;
    const foreign = await prismaService.product.create({
      data: { tenantId: b.id, sku: "PB-1", title: "B's product", vendor: "House" },
    });
    foreignProduct = foreign.id;
  });

  const written = () =>
    prismaService.ownerPrior.findMany({ select: { tenantId: true, scopeValue: true, proxyProductId: true } });

  it("refuses a product-scoped prior on another workspace's product", async () => {
    const res = await createOwnerPrior(tenantA, {
      scope: "product",
      scopeValue: foreignProduct,
      expectedUnits: 120,
    });

    expect({ ok: res.ok, rows: await written() }).toEqual({ ok: false, rows: [] });
  });

  it("refuses a 'sell like' proxy from another workspace", async () => {
    const res = await createOwnerPrior(tenantA, {
      scope: "product",
      scopeValue: ownProduct,
      proxyProductId: foreignProduct,
    });

    expect({ ok: res.ok, rows: await written() }).toEqual({ ok: false, rows: [] });
  });

  /** Negative control: the same calls on the tenant's OWN product must succeed,
   *  so a green result above can never be the writer failing for another reason. */
  it("accepts a prior on the caller's own product", async () => {
    const scoped = await createOwnerPrior(tenantA, {
      scope: "product",
      scopeValue: ownProduct,
      expectedUnits: 120,
    });
    const borrowed = await createOwnerPrior(tenantA, {
      scope: "product",
      scopeValue: ownProduct,
      proxyProductId: ownProduct,
    });
    // A brand prior names no product at all — the guard must not reach for one.
    const brand = await createOwnerPrior(tenantA, {
      scope: "brand",
      scopeValue: "House",
      multiplier: 1.2,
    });

    expect([scoped.ok, borrowed.ok, brand.ok]).toEqual([true, true, true]);
    expect((await written()).length).toBe(3);
  });
});
