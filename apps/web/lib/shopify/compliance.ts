import { prismaService } from "@wezesha/db";
import { connectionByShopDomain } from "./resolve";

/**
 * Shopify's three mandatory compliance webhooks. Every public app must answer
 * them; an app that doesn't fails review.
 *
 * They are NOT ordinary data webhooks. Shopify delivers them to the URLs set in
 * the Partner dashboard rather than to subscriptions the app creates, and
 * `shop/redact` arrives ~48h AFTER an uninstall — by which time the connection
 * may already be gone. So these are handled before the receiver's
 * connection-required path, and a missing shop is a success, not an error.
 *
 * What we actually hold, established by reading the code rather than assuming:
 *  - `packages/shopify/src` never requests a customer, email, phone or address
 *    field from Shopify. Nothing shopper-identifying is fetched.
 *  - SalesHistory — the only place Shopify order data lands — stores product,
 *    day, quantity, revenue and branch. No customer, no order id.
 * So a customer data request has nothing to return and a customer redaction has
 * nothing to erase. Both are still recorded: "we hold none" is an answer we may
 * need to evidence later.
 *
 * (PosSale.customer can carry a name, but it arrives on the merchant's own till
 * feed, not from Shopify, and cannot be correlated to a Shopify customer id.
 * It is out of scope here and must not be silently deleted on Shopify's say-so.)
 */

export type ComplianceTopic = "customers/data_request" | "customers/redact" | "shop/redact";

export const COMPLIANCE_TOPICS = new Set<string>([
  "customers/data_request",
  "customers/redact",
  "shop/redact",
]);

export function isComplianceTopic(topic: string): topic is ComplianceTopic {
  return COMPLIANCE_TOPICS.has(topic);
}

/** Append-only note that the request arrived and what we did about it. Written
 *  even when there is nothing to erase — the record IS the compliance artefact. */
async function record(
  tenantId: string | null,
  topic: ComplianceTopic,
  shopDomain: string,
  meta: Record<string, unknown>
): Promise<void> {
  if (!tenantId) return; // AuditEvent is tenant-scoped; an unknown shop leaves no trail to write.
  try {
    await prismaService.auditEvent.create({
      data: {
        tenantId,
        entity: "Shop",
        entityId: shopDomain,
        action: topic.replace("/", "_"),
        actorName: "Shopify",
        meta: meta as never,
      },
    });
  } catch (err) {
    // Never fail the webhook over the ledger — Shopify retries, and a repeated
    // non-2xx ends in a forced unsubscribe.
    console.error(`compliance: could not record ${topic} for ${shopDomain}`, err);
  }
}

/**
 * Erase what came FROM Shopify: the access token and connection, the sync
 * bookkeeping, and the sales history derived from the store's orders.
 *
 * Deliberately NOT deleted: the workspace, and the merchant's own work inside
 * it — typed costs, suppliers, purchase orders. That is the shop's own business
 * record, not Shopify's data, and destroying it on an automated trigger would
 * be a far worse failure than keeping it. Products are unlinked from Shopify
 * rather than dropped, for the same reason: purchase orders and cost history
 * hang off those rows.
 *
 * Guarded on the connection being uninstalled. Shopify only sends shop/redact
 * after an uninstall, so a live connection here means something is wrong, and
 * "wrong" must not mean "wipe a working tenant".
 */
export async function redactShop(shopDomain: string): Promise<{ erased: boolean; reason?: string }> {
  const connection = await connectionByShopDomain(shopDomain);
  if (!connection) {
    // Already gone — offboarded, or never ours. Nothing to erase.
    return { erased: false, reason: "no connection" };
  }
  const { tenantId } = connection;

  if (!connection.uninstalledAt) {
    console.error(`compliance: shop/redact for ${shopDomain} while the connection is still live`);
    await record(tenantId, "shop/redact", shopDomain, { erased: false, reason: "connection live" });
    return { erased: false, reason: "connection still live" };
  }

  const sales = await prismaService.salesHistory.deleteMany({ where: { tenantId, channel: "shopify" } });
  const products = await prismaService.product.updateMany({
    where: { tenantId, source: "shopify" },
    data: { shopifyProductId: null, shopifyVariantId: null, imageUrl: null, shopifyCreatedAt: null, publishedAt: null },
  });
  await prismaService.location.updateMany({
    where: { tenantId, shopifyLocationId: { not: null } },
    data: { shopifyLocationId: null },
  });
  await prismaService.ingestCursor.deleteMany({ where: { tenantId, source: "shopify" } });
  await prismaService.syncRun.deleteMany({ where: { tenantId, source: "shopify" } });
  // The token last: while it exists the store is still reachable, and losing it
  // early would strand the rows above.
  await prismaService.shopifyConnection.deleteMany({ where: { tenantId } });

  await record(tenantId, "shop/redact", shopDomain, {
    erased: true,
    salesRowsDeleted: sales.count,
    productsUnlinked: products.count,
  });
  return { erased: true };
}

/** Nothing shopper-identifying is stored, so this records the request and
 *  reports that there is nothing to hand over. */
export async function handleCustomerDataRequest(shopDomain: string): Promise<void> {
  const connection = await connectionByShopDomain(shopDomain);
  await record(connection?.tenantId ?? null, "customers/data_request", shopDomain, {
    personalDataHeld: false,
    note: "No shopper-identifying data is requested from Shopify or stored.",
  });
}

/** Nothing shopper-identifying is stored, so there is nothing to erase. */
export async function handleCustomerRedact(shopDomain: string): Promise<void> {
  const connection = await connectionByShopDomain(shopDomain);
  await record(connection?.tenantId ?? null, "customers/redact", shopDomain, {
    personalDataHeld: false,
    note: "Nothing to erase — no shopper-identifying data is stored.",
  });
}
