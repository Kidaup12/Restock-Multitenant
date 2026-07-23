import { NextResponse, type NextRequest } from "next/server";
import { Prisma, prismaService } from "@wezesha/db";
import { verifyWebhookHmac } from "@wezesha/shopify";
import { connectionByShopDomain } from "@/lib/shopify/resolve";
import { enqueueShopifySync, publishRealtime } from "@/lib/shopify/queue";

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
 */

const SYNC_TOPICS = new Set(["products/update", "inventory_levels/update", "orders/create"]);

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    console.error("webhook: SHOPIFY_API_SECRET is not set");
    return NextResponse.json({ error: "not configured" }, { status: 500 });
  }

  const raw = await req.text();
  const hmac = req.headers.get("x-shopify-hmac-sha256") ?? "";
  if (!verifyWebhookHmac(raw, hmac, secret)) {
    return NextResponse.json({ error: "invalid hmac" }, { status: 401 });
  }

  const webhookId = req.headers.get("x-shopify-webhook-id") ?? "";
  const topic = req.headers.get("x-shopify-topic") ?? "";
  const shopDomain = (req.headers.get("x-shopify-shop-domain") ?? "").toLowerCase();
  if (!webhookId || !topic || !shopDomain) {
    return NextResponse.json({ error: "missing shopify headers" }, { status: 400 });
  }

  try {
    await prismaService.webhookEvent.create({ data: { webhookId, topic, shopDomain } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json({ ok: true, duplicate: true });
    }
    throw err;
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
