import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { upsertPlanOverride } from "../lib/data/plan";

/**
 * A plan override names a product by id, and the id arrives from the browser.
 *
 * RLS scopes the row being written — tenantId on ProductPlanOverride — but it
 * has nothing to say about the product that row points at. Nothing else does
 * either: ProductPlanOverride carries no foreign key on productId, and the
 * writer never reads the product back on the tenant client. So the only guard
 * that could reject a product id belonging to another workspace would be a
 * scoped read, and there isn't one.
 *
 * This asserts the override is refused. If it is written, the write path is
 * accepting a foreign product id.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const SLUG_A = "override-fk-a";
const SLUG_B = "override-fk-b";

describe.skipIf(!runnable)("plan override with a foreign productId (local db)", () => {
  let tenantA: string;
  let productB: string;

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
    await prismaService.$disconnect();
  });

  beforeEach(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
    const a = await prismaService.tenant.create({
      data: { name: "Override A", slug: SLUG_A, currency: "KES" },
    });
    const b = await prismaService.tenant.create({
      data: { name: "Override B", slug: SLUG_B, currency: "KES" },
    });
    tenantA = a.id;
    await prismaService.product.create({
      data: { tenantId: a.id, sku: "A-1", title: "A's product", vendor: "House" },
    });
    const foreign = await prismaService.product.create({
      data: { tenantId: b.id, sku: "B-1", title: "B's product", vendor: "House" },
    });
    productB = foreign.id;
  });

  it("refuses an override keyed on another workspace's product", async () => {
    const outcome = await upsertPlanOverride(tenantA, { productId: productB, qty: 42 })
      .then(() => "written" as const)
      .catch(() => "refused" as const);

    // What the row looks like, so a failure names the workspaces involved.
    const written = await prismaService.productPlanOverride.findMany({
      where: { productId: productB },
      select: { tenantId: true, productId: true, qty: true },
    });
    expect({ outcome, written }).toEqual({ outcome: "refused", written: [] });
  });

  /** Negative control: the same call with the tenant's OWN product must succeed,
   *  so a green result above can never be the writer failing for another reason. */
  it("accepts an override on the caller's own product", async () => {
    const own = await prismaService.product.findFirstOrThrow({
      where: { tenantId: tenantA },
      select: { id: true },
    });
    await upsertPlanOverride(tenantA, { productId: own.id, qty: 7 });
    const row = await prismaService.productPlanOverride.findFirst({
      where: { tenantId: tenantA, productId: own.id },
      select: { qty: true },
    });
    expect(row?.qty).toBe(7);
  });
});
