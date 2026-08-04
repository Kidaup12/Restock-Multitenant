import { NextResponse, type NextRequest } from "next/server";
import { Prisma, prismaService } from "@wezesha/db";
import { isValidShopDomain, numericCore, verifyWebhookHmac } from "@wezesha/shopify";
import { credentialsForShopDomain } from "@/lib/shopify/credentials";
import { connectionByShopDomain } from "@/lib/shopify/resolve";
import { enqueueShopifySync, publishRealtime } from "@/lib/shopify/queue";
import {
  handleCustomerDataRequest,
  handleCustomerRedact,
  isComplianceTopic,
  redactShop,
} from "@/lib/shopify/compliance";

/**
 * Shopify webhook receiver. Enqueue-only: verify, dedupe, kick a worker job,
 * answer 200 fast — Shopify starts failing an endpoint that dawdles, and
 * repeated failures end in a forced unsubscribe.
 *
 * Idempotency: the WebhookEvent insert on the unique delivery id is the gate.
 * A redelivery loses the insert race (P2002) and short-circuits to 200.
 *
 * Data topics don't parse the payload at all: any product/inventory/order
 * change just means "this tenant's next delta sync should run now". The
 * cursor-overlap window makes a coalesced/missed trigger self-healing.
 *
 * products/delete is the one exception: a deleted product is never returned by
 * a products pull, so no sync — delta or otherwise — can learn about it from
 * the payload. It is handled inline instead.
 *
 * The three mandatory compliance topics (customers/data_request,
 * customers/redact, shop/redact) are also handled here — see lib/shopify/
 * compliance.ts for what each one does and why. They still run before the
 * connection-required path because shop/redact outlives the connection, but
 * they no longer outlive the CREDENTIAL: signing secrets are per workspace, so
 * a delivery whose shop resolves to no stored secret cannot be verified and is
 * refused above. Disconnecting keeps both rows (uninstalledAt is stamped, the
 * credential is left alone) precisely so a late shop/redact still verifies;
 * only full offboarding, which deletes the tenant, closes that door — and a
 * deleted tenant has nothing left to redact.
 */

const SYNC_TOPICS = new Set(["products/update", "inventory_levels/update", "orders/create"]);

/**
 * The delete payload carries only the PRODUCT id, usually as a bare number
 * ({"id": 123}). Rows store the numeric core of the gid, so normalize either
 * spelling through numericCore before matching or the update silently hits
 * nothing.
 */
function deletedProductId(raw: string): string | null {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  const id = (payload as { id?: unknown } | null)?.id;
  if (typeof id !== "string" && typeof id !== "number") return null;
  const core = numericCore(String(id)).trim();
  return core || null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const webhookId = req.headers.get("x-shopify-webhook-id") ?? "";
  const topic = req.headers.get("x-shopify-topic") ?? "";
  const shopDomain = (req.headers.get("x-shopify-shop-domain") ?? "").toLowerCase();
  if (!webhookId || !topic || !shopDomain) {
    return NextResponse.json({ error: "missing shopify headers" }, { status: 400 });
  }
  // Reject a malformed domain before it reaches the database, so an
  // unauthenticated caller cannot turn this endpoint into a query generator.
  if (!isValidShopDomain(shopDomain)) {
    return NextResponse.json({ error: "invalid hmac" }, { status: 401 });
  }

  // Signing secrets are per workspace now, so the shop has to be identified
  // BEFORE the signature can be checked. The header only selects which key to
  // try — it grants nothing, and a forged domain just selects a key the forged
  // body will not verify against. The tenant that is actually acted on below
  // comes from the resolved row, never from the header.
  const resolved = await credentialsForShopDomain(shopDomain);

  const raw = await req.text();
  const hmac = req.headers.get("x-shopify-hmac-sha256") ?? "";
  // An unknown shop and a bad signature return the identical response: a
  // difference here would tell an unauthenticated caller which stores exist.
  if (!resolved || !verifyWebhookHmac(raw, hmac, resolved.apiSecret)) {
    return NextResponse.json({ error: "invalid hmac" }, { status: 401 });
  }

  try {
    await prismaService.webhookEvent.create({ data: { webhookId, topic, shopDomain } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json({ ok: true, duplicate: true });
    }
    throw err;
  }

  // Compliance topics run BEFORE the connection lookup: shop/redact arrives
  // about 48h after an uninstall, by which time there may be no connection to
  // find, and "no connection" must not turn a mandatory erasure into a no-op.
  if (isComplianceTopic(topic)) {
    try {
      if (topic === "shop/redact") await redactShop(shopDomain);
      else if (topic === "customers/redact") await handleCustomerRedact(shopDomain);
      else await handleCustomerDataRequest(shopDomain);
    } catch (err) {
      // Shopify retries a non-2xx and eventually force-unsubscribes, which
      // would be worse than a logged failure we can replay by hand.
      console.error(`webhook: ${topic} failed for ${shopDomain}`, err);
    }
    return NextResponse.json({ ok: true });
  }

  const connection = await connectionByShopDomain(shopDomain);
  if (!connection) {
    // Unknown store (e.g. connected elsewhere, or already offboarded). 200 so
    // Shopify stops retrying — there is nothing here to deliver to.
    return NextResponse.json({ ok: true, ignored: true });
  }
  const { tenantId } = connection;

  if (topic === "app/uninstalled") {
    await prismaService.shopifyConnection.updateMany({
      where: { tenantId, uninstalledAt: null },
      data: { uninstalledAt: new Date() },
    });
    await prismaService.notification.create({
      data: {
        tenantId,
        kind: "shopify_uninstalled",
        title: "Shopify app uninstalled",
        body: `The app was uninstalled from ${shopDomain}. Reconnect the store under Settings → Connections to resume syncing.`,
      },
    });
    await publishRealtime({
      type: "notification.new",
      data: { tenantId, kind: "shopify_uninstalled", title: "Shopify app uninstalled" },
    }).catch(() => {});
    return NextResponse.json({ ok: true });
  }

  if (topic === "products/delete") {
    const shopifyProductId = deletedProductId(raw);
    if (!shopifyProductId) {
      // A body we can't read an id out of reads the same on every retry, so a
      // non-2xx would only burn the retry budget towards a forced unsubscribe.
      console.error(`webhook: products/delete without a usable id from ${shopDomain}`);
      return NextResponse.json({ ok: true, ignored: true });
    }
    // Never delete the rows: sales history, past POs and the dead-stock view
    // all hang off them. Stamping mirrors what the full sync's sweep does, and
    // skipping already-stamped rows keeps the original "gone since" date
    // through a redelivery or a later sweep.
    await prismaService.product.updateMany({
      where: { tenantId, source: "shopify", shopifyProductId, missingFromShopifyAt: null },
      data: { missingFromShopifyAt: new Date() },
    });
    return NextResponse.json({ ok: true });
  }

  if (SYNC_TOPICS.has(topic) && !connection.uninstalledAt) {
    try {
      await enqueueShopifySync(tenantId);
    } catch (err) {
      // Missed trigger, not a lost webhook: the next scheduled sync's overlap
      // window re-pulls this change. Never bounce Shopify over our queue.
      console.error("webhook: sync enqueue failed", err);
    }
  }

  return NextResponse.json({ ok: true });
}
