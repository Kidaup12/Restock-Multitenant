import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Setting one lead time across many products at once, against the local
 * database. Lead time decides WHEN to order — with none set, every order-by date
 * is computed as if stock arrives the instant it is ordered — and until this
 * action existed it could only be written one product at a time, which is why
 * no live workspace has one.
 *
 * The rules worth holding: an id from another workspace cannot be reached even
 * though the caller supplies the ids; "all matching" resolves the reader's
 * filters on the server rather than trusting a list the browser assembled; a
 * member cannot use it; and the audit says how the set was chosen. Session and
 * revalidation are stubbed; the database work is real. Skips with no local db.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const authState = vi.hoisted(() => ({
  session: null as { user: { id: string; name: string | null; email: string } } | null,
  membership: null as
    | {
        tenantId: string;
        displayName: string | null;
        role: string;
        permissions: unknown;
        tenant: { currency: string };
      }
    | null,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({
  requireSession: async () => authState.session,
  activeMembership: async () => authState.membership,
}));

import { prismaForTenant, prismaService } from "@wezesha/db";
import { DEFAULT_QUERY } from "@/lib/catalogue";
import { setLeadTimeForProductsAction } from "../app/(shell)/stock/actions";

const SLUGS = ["bulk-lead-a", "bulk-lead-b"];

describe.skipIf(!runnable)("bulk lead time (local db)", () => {
  let tenantA: string;
  let tenantB: string;
  const A: Record<string, string> = {};
  let foreign: string;

  async function product(tenantId: string, sku: string, over: Record<string, unknown> = {}) {
    const p = await prismaService.product.create({
      data: {
        tenantId,
        sku,
        title: `Product ${sku}`,
        priceKes: 1000,
        costKes: 400,
        costSource: "manual",
        currentStock: 6,
        ...over,
      },
    });
    return p.id;
  }

  const leadOf = async (tenantId: string, id: string) =>
    (await prismaForTenant(tenantId).product.findUnique({ where: { id }, select: { leadTimeDays: true } }))
      ?.leadTimeDays ?? null;

  beforeAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: { in: SLUGS } } });
    tenantA = (await prismaService.tenant.create({ data: { name: "Bulk Lead A", slug: SLUGS[0]! } })).id;
    tenantB = (await prismaService.tenant.create({ data: { name: "Bulk Lead B", slug: SLUGS[1]! } })).id;

    A.one = await product(tenantA, "BULK-1", { vendor: "Nivea" });
    A.two = await product(tenantA, "BULK-2", { vendor: "Nivea" });
    A.three = await product(tenantA, "BULK-3", { vendor: "Cantu" });
    foreign = await product(tenantB, "BULK-FOREIGN");
  });

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    await prismaService.$disconnect();
  });

  function actAs(tenantId: string, permissions: unknown) {
    authState.session = { user: { id: "actor-1", name: "Owner", email: "owner@example.test" } };
    authState.membership = {
      tenantId,
      displayName: "Owner",
      role: permissions === null ? "OWNER" : "MEMBER",
      permissions,
      tenant: { currency: "KES" },
    };
  }

  it("sets one lead time across the products that were ticked", async () => {
    actAs(tenantA, null);
    const res = await setLeadTimeForProductsAction({
      leadTimeDays: 14,
      productIds: [A.one!, A.two!],
    });
    expect(res.ok).toBe(true);

    expect(await leadOf(tenantA, A.one!)).toBe(14);
    expect(await leadOf(tenantA, A.two!)).toBe(14);
    // Untouched rows stay untouched — a bulk write is not a whole-table write.
    expect(await leadOf(tenantA, A.three!)).toBeNull();
  });

  it("cannot reach a product in another workspace, even when handed its id", async () => {
    actAs(tenantA, null);
    const res = await setLeadTimeForProductsAction({
      leadTimeDays: 30,
      productIds: [A.three!, foreign],
    });
    expect(res.ok).toBe(true);

    expect(await leadOf(tenantA, A.three!)).toBe(30);
    // The foreign row never came back from the tenant client, so the write
    // could not name it.
    expect(await leadOf(tenantB, foreign)).toBeNull();
  });

  it("refuses an id list that belongs entirely to someone else", async () => {
    actAs(tenantA, null);
    const res = await setLeadTimeForProductsAction({ leadTimeDays: 7, productIds: [foreign] });
    expect(res.ok).toBe(false);
    expect(await leadOf(tenantB, foreign)).toBeNull();
  });

  it("applies to every row the reader's filters match, not just the page", async () => {
    actAs(tenantA, null);
    const res = await setLeadTimeForProductsAction({
      leadTimeDays: 21,
      query: { ...DEFAULT_QUERY, search: "nivea" },
    });
    expect(res.ok).toBe(true);

    expect(await leadOf(tenantA, A.one!)).toBe(21);
    expect(await leadOf(tenantA, A.two!)).toBe(21);
    // Cantu did not match the search, so it keeps what it had.
    expect(await leadOf(tenantA, A.three!)).toBe(30);
  });

  it("clears the lead time back to the supplier's figure", async () => {
    actAs(tenantA, null);
    expect((await setLeadTimeForProductsAction({ leadTimeDays: null, productIds: [A.one!] })).ok).toBe(true);
    expect(await leadOf(tenantA, A.one!)).toBeNull();
  });

  it("rejects a lead time outside the sensible range and writes nothing", async () => {
    actAs(tenantA, null);
    for (const bad of [-1, 366]) {
      const res = await setLeadTimeForProductsAction({ leadTimeDays: bad, productIds: [A.two!] });
      expect(res.ok).toBe(false);
    }
    expect(await leadOf(tenantA, A.two!)).toBe(21);
  });

  it("is refused for a member without settings access", async () => {
    actAs(tenantA, ["approve_orders"]);
    const res = await setLeadTimeForProductsAction({ leadTimeDays: 5, productIds: [A.two!] });
    expect(res.ok).toBe(false);
    expect(await leadOf(tenantA, A.two!)).toBe(21);
  });

  it("records how the set was chosen, so a blanket change is findable later", async () => {
    const events = await prismaForTenant(tenantA).auditEvent.findMany({
      where: { entity: "Product", action: "edited" },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    const metas = events.map((e) => e.meta as Record<string, unknown>);
    expect(metas).toContainEqual(expect.objectContaining({ action: "bulk_lead_time", scope: "filtered", to: 21 }));
    expect(metas).toContainEqual(expect.objectContaining({ action: "bulk_lead_time", scope: "picked", to: 14 }));
  });

  it("says nothing changed rather than writing an audit row for a no-op", async () => {
    actAs(tenantA, null);
    const before = await prismaForTenant(tenantA).auditEvent.count({ where: { entity: "Product" } });
    const res = await setLeadTimeForProductsAction({ leadTimeDays: 21, productIds: [A.two!] });
    expect(res.ok).toBe(true);
    expect(await prismaForTenant(tenantA).auditEvent.count({ where: { entity: "Product" } })).toBe(before);
  });
});
