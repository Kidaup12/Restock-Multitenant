import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { encryptToken, reconcilePurchaseOrders } from "@wezesha/quickbooks";

/**
 * Matching a workspace's purchase orders against its books.
 *
 * The assertion that matters most is the one about on-order: this is an
 * evidence track and must never move the number the buy list restocks against.
 * If a books mismatch could suppress a restock, a bad match would take a shop
 * out of stock — the exact harm the phantom check exists to prevent.
 */

// Same convention as the Shopify suites: a fixed local key so encryptToken works.
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 9).toString("base64");

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const SLUG = "qb-reconcile-test";
const NOW = new Date("2026-08-31T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

/** A books response, without a real HTTP stack. */
function booksReturning(docs: unknown[]): typeof fetch {
  return (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ QueryResponse: { PurchaseOrder: docs } }),
    }) as unknown as Response) as unknown as typeof fetch;
}

const qbDoc = (over: Record<string, unknown> = {}) => ({
  Id: "qb-1",
  DocNumber: "PO-1001",
  TotalAmt: 10_000,
  TxnDate: "2026-08-21",
  VendorRef: { value: "7", name: "Amara Supplies" },
  ...over,
});

describe.skipIf(!runnable)("reconciling purchase orders with QuickBooks (seeded local db)", () => {
  let tenantId: string;
  let poId: string;
  let productId: string;

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    await prismaService.$disconnect();
  });

  beforeEach(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    const tenant = await prismaService.tenant.create({
      data: { name: "QB Reconcile", slug: SLUG, currency: "KES" },
    });
    tenantId = tenant.id;

    await prismaService.quickBooksConnection.create({
      data: {
        tenantId,
        realmId: `realm-${tenant.id}`,
        accessToken: encryptToken("access-token"),
        refreshToken: encryptToken("refresh-token"),
        accessTokenExpiresAt: new Date(NOW.getTime() + 60 * 60 * 1000),
        refreshTokenExpiresAt: new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000),
        scopes: "com.intuit.quickbooks.accounting",
      },
    });

    const product = await prismaService.product.create({
      data: { tenantId, sku: "SKU-1", title: "A product", vendor: "Amara Supplies", onOrder: 12 },
    });
    productId = product.id;

    const po = await prismaService.purchaseOrder.create({
      data: {
        tenantId,
        poNumber: "PO-1001",
        vendor: "Amara Supplies",
        status: "sent",
        subtotalKes: 10_000,
        sentAt: daysAgo(10),
      },
    });
    poId = po.id;
  });

  const read = () =>
    prismaService.purchaseOrder.findUniqueOrThrow({
      where: { id: poId },
      select: { qbConfirmedAt: true, qbDocRef: true, qbSuggestion: true, needsAttention: true },
    });

  it("confirms an order whose document number is in the books", async () => {
    const res = await reconcilePurchaseOrders({
      tenantId,
      now: NOW,
      fetchImpl: booksReturning([qbDoc()]),
    });

    expect(res).toMatchObject({ ok: true, confirmed: 1, phantoms: 0 });
    const po = await read();
    expect(po.qbConfirmedAt).not.toBeNull();
    expect(po.qbDocRef).toBe("PO-1001");
    expect(po.needsAttention).toBe(false);
  });

  it("does not touch the on-order figure — evidence never moves stock", async () => {
    const before = await prismaService.product.findUniqueOrThrow({
      where: { id: productId },
      select: { onOrder: true },
    });
    await reconcilePurchaseOrders({
      tenantId,
      now: NOW,
      fetchImpl: booksReturning([qbDoc()]),
    });
    const after = await prismaService.product.findUniqueOrThrow({
      where: { id: productId },
      select: { onOrder: true },
    });
    expect(after.onOrder, "matching the books changed what the buy list restocks against").toBe(
      before.onOrder,
    );
  });

  it("suggests a lookalike without confirming it", async () => {
    const res = await reconcilePurchaseOrders({
      tenantId,
      now: NOW,
      fetchImpl: booksReturning([qbDoc({ DocNumber: "1042" })]),
    });

    expect(res).toMatchObject({ ok: true, confirmed: 0, suggested: 1 });
    const po = await read();
    expect(po.qbConfirmedAt, "a lookalike was treated as proof").toBeNull();
    expect(po.qbSuggestion).toContain("1042");
  });

  it("flags an order the books have never seen", async () => {
    const res = await reconcilePurchaseOrders({
      tenantId,
      now: NOW,
      fetchImpl: booksReturning([]),
    });

    expect(res).toMatchObject({ ok: true, confirmed: 0, phantoms: 1 });
    expect((await read()).needsAttention).toBe(true);
  });

  it("reports documents raised in the books that we did not raise", async () => {
    const res = await reconcilePurchaseOrders({
      tenantId,
      now: NOW,
      fetchImpl: booksReturning([qbDoc(), qbDoc({ Id: "qb-2", DocNumber: "QB-900" })]),
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.external.map((d) => d.id)).toEqual(["qb-2"]);
  });

  it("keeps a confirmation once made, even if the document leaves the books", async () => {
    await reconcilePurchaseOrders({ tenantId, now: NOW, fetchImpl: booksReturning([qbDoc()]) });
    const first = await read();

    // The books no longer return it — a deletion, or a narrower window.
    const later = new Date(NOW.getTime() + 60 * 60 * 1000);
    await reconcilePurchaseOrders({ tenantId, now: later, fetchImpl: booksReturning([]) });

    const second = await read();
    expect(second.qbConfirmedAt).toEqual(first.qbConfirmedAt);
    expect(second.needsAttention, "a confirmed order was flagged as missing").toBe(false);
  });

  it("says it is not connected rather than guessing, with no connection", async () => {
    await prismaService.quickBooksConnection.deleteMany({ where: { tenantId } });
    const res = await reconcilePurchaseOrders({
      tenantId,
      now: NOW,
      fetchImpl: booksReturning([qbDoc()]),
    });
    expect(res).toMatchObject({ ok: false, reason: "not_connected" });
  });
});
