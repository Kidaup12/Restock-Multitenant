import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";

/**
 * The three mandatory compliance webhooks, against the real route handler and
 * the local database. Shopify checks these at review, and the one with teeth is
 * shop/redact: it must erase what came from the store, must survive arriving
 * after the connection is gone, and must not take the merchant's own records
 * with it.
 */

const dbUrl = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(dbUrl);

const SECRET = "compliance-test-secret";
const SLUG = "compliance-test-tenant";
const SHOP = "compliance-test-store.myshopify.com";
const LIVE_SLUG = "compliance-live-tenant";
const LIVE_SHOP = "compliance-live-store.myshopify.com";
const base = "http://webhook.test";

function sign(body: string): string {
  return crypto.createHmac("sha256", SECRET).update(body).digest("base64");
}

function webhookRequest(opts: {
  body: string;
  topic: string;
  webhookId: string;
  shop: string;
  hmac?: string;
}): Request {
  return new Request(`${base}/api/webhooks/shopify`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-hmac-sha256": opts.hmac ?? sign(opts.body),
      "x-shopify-topic": opts.topic,
      "x-shopify-webhook-id": opts.webhookId,
      "x-shopify-shop-domain": opts.shop,
    },
    body: opts.body,
  });
}

describe.skipIf(!runnable)("shopify compliance webhooks (real db)", () => {
  let POST: (req: Request) => Promise<Response>;
  let prismaService: typeof import("@wezesha/db").prismaService;
  let tenantId: string;
  let liveTenantId: string;
  let productId: string;
  const run = Date.now().toString(36);

  beforeAll(async () => {
    process.env.SHOPIFY_API_SECRET = SECRET;
    ({ prismaService } = await import("@wezesha/db"));
    ({ POST } = (await import("../app/api/webhooks/shopify/route")) as unknown as {
      POST: (req: Request) => Promise<Response>;
    });

    await prismaService.tenant.deleteMany({ where: { slug: { in: [SLUG, LIVE_SLUG] } } });

    // The redacted shop: uninstalled, with Shopify-derived data AND the
    // merchant's own records alongside it.
    const tenant = await prismaService.tenant.create({ data: { name: "Compliance Test", slug: SLUG } });
    tenantId = tenant.id;
    await prismaService.shopifyConnection.create({
      data: {
        tenantId,
        shopDomain: SHOP,
        accessToken: "ciphertext",
        scopes: "read_products",
        uninstalledAt: new Date(),
      },
    });
    const product = await prismaService.product.create({
      data: {
        tenantId,
        sku: `COMP-${run}`,
        title: "Compliance Product",
        source: "shopify",
        shopifyProductId: "9001",
        shopifyVariantId: "9002",
        costKes: 250,
      },
    });
    productId = product.id;
    await prismaService.salesHistory.create({
      data: { tenantId, productId, date: new Date("2026-06-01T00:00:00Z"), quantity: 3, revenueKes: 900, channel: "shopify" },
    });
    await prismaService.ingestCursor.create({
      data: { tenantId, source: "shopify", resource: "products", cursor: new Date() },
    });
    await prismaService.syncRun.create({ data: { tenantId, source: "shopify", status: "ok" } });
    await prismaService.supplier.create({ data: { tenantId, name: `Supplier ${run}` } });

    // A second shop that is still installed — shop/redact there must be refused.
    const live = await prismaService.tenant.create({ data: { name: "Compliance Live", slug: LIVE_SLUG } });
    liveTenantId = live.id;
    await prismaService.shopifyConnection.create({
      data: { tenantId: liveTenantId, shopDomain: LIVE_SHOP, accessToken: "ciphertext", scopes: "read_products" },
    });
  });

  afterAll(async () => {
    await prismaService.webhookEvent.deleteMany({ where: { shopDomain: { contains: "compliance-" } } });
    await prismaService.tenant.deleteMany({ where: { slug: { in: [SLUG, LIVE_SLUG] } } });
    await prismaService.$disconnect();
  });

  it("rejects an unsigned compliance request", async () => {
    const body = JSON.stringify({ shop_domain: SHOP });
    const res = await POST(
      webhookRequest({ body, topic: "shop/redact", webhookId: `${run}-c0`, shop: SHOP, hmac: sign("tampered") })
    );
    expect(res.status).toBe(401);
    // And nothing was erased on the way to rejecting it.
    expect(await prismaService.shopifyConnection.findUnique({ where: { shopDomain: SHOP } })).not.toBeNull();
  });

  it("answers a customer data request, recording that we hold none", async () => {
    const body = JSON.stringify({ shop_domain: SHOP, customer: { id: 123 } });
    const res = await POST(webhookRequest({ body, topic: "customers/data_request", webhookId: `${run}-c1`, shop: SHOP }));
    expect(res.status).toBe(200);

    const entry = await prismaService.auditEvent.findFirst({
      where: { tenantId, action: "customers_data_request" },
    });
    expect(entry).not.toBeNull();
    expect(entry!.meta).toMatchObject({ personalDataHeld: false });
  });

  it("answers a customer redaction, recording that there is nothing to erase", async () => {
    const body = JSON.stringify({ shop_domain: SHOP, customer: { id: 123 } });
    const res = await POST(webhookRequest({ body, topic: "customers/redact", webhookId: `${run}-c2`, shop: SHOP }));
    expect(res.status).toBe(200);
    expect(
      await prismaService.auditEvent.findFirst({ where: { tenantId, action: "customers_redact" } })
    ).not.toBeNull();
  });

  it("refuses to erase a shop whose connection is still live", async () => {
    const body = JSON.stringify({ shop_domain: LIVE_SHOP });
    const res = await POST(webhookRequest({ body, topic: "shop/redact", webhookId: `${run}-c3`, shop: LIVE_SHOP }));
    expect(res.status).toBe(200);

    // Still there — an anomalous redact must never wipe a working tenant.
    expect(await prismaService.shopifyConnection.findUnique({ where: { shopDomain: LIVE_SHOP } })).not.toBeNull();
    const entry = await prismaService.auditEvent.findFirst({
      where: { tenantId: liveTenantId, action: "shop_redact" },
    });
    expect(entry!.meta).toMatchObject({ erased: false });
  });

  it("answers 200 for a shop it has never heard of", async () => {
    const body = JSON.stringify({ shop_domain: "compliance-unknown.myshopify.com" });
    const res = await POST(
      webhookRequest({ body, topic: "shop/redact", webhookId: `${run}-c4`, shop: "compliance-unknown.myshopify.com" })
    );
    expect(res.status).toBe(200);
  });

  it("erases the store's data, and leaves the merchant's own records standing", async () => {
    const body = JSON.stringify({ shop_domain: SHOP });
    const res = await POST(webhookRequest({ body, topic: "shop/redact", webhookId: `${run}-c5`, shop: SHOP }));
    expect(res.status).toBe(200);

    // Gone: the token, the sync bookkeeping, and the order-derived history.
    expect(await prismaService.shopifyConnection.findUnique({ where: { shopDomain: SHOP } })).toBeNull();
    expect(await prismaService.ingestCursor.count({ where: { tenantId } })).toBe(0);
    expect(await prismaService.syncRun.count({ where: { tenantId } })).toBe(0);
    expect(await prismaService.salesHistory.count({ where: { tenantId, channel: "shopify" } })).toBe(0);

    // Kept, deliberately: the workspace and the merchant's own work. The
    // product row survives unlinked, because purchase orders and typed costs
    // hang off it.
    const product = await prismaService.product.findUnique({ where: { id: productId } });
    expect(product).not.toBeNull();
    expect(product!.shopifyProductId).toBeNull();
    expect(product!.shopifyVariantId).toBeNull();
    expect(product!.costKes).toBe(250);
    expect(await prismaService.supplier.count({ where: { tenantId } })).toBe(1);
    expect(await prismaService.tenant.findUnique({ where: { id: tenantId } })).not.toBeNull();

    const entry = await prismaService.auditEvent.findFirst({
      where: { tenantId, action: "shop_redact" },
      orderBy: { createdAt: "desc" },
    });
    expect(entry!.meta).toMatchObject({ erased: true, salesRowsDeleted: 1, productsUnlinked: 1 });
  });
});
