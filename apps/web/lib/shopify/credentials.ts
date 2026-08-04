import { prismaForTenant, prismaService } from "@wezesha/db";
import { decryptToken } from "@wezesha/shopify";

/**
 * Per-workspace Shopify app credentials.
 *
 * Wezesha holds no Shopify app of its own. Each client registers its own app
 * and enters the client id and secret under Settings → Connections, and those
 * are the only credentials any Shopify flow uses. There is deliberately NO
 * environment fallback: a shared SHOPIFY_API_KEY / SHOPIFY_API_SECRET is what
 * previously made it impossible for a client to connect its own store, and a
 * fallback would quietly reintroduce it the moment a lookup missed.
 *
 * A workspace with no row here cannot run an OAuth install and cannot have a
 * webhook verified. Both fail closed, with a message pointing at the form.
 *
 * The client id is stored in the clear (it travels in the authorize URL the
 * merchant's own browser visits). The secret is AES-256-GCM ciphertext under
 * TOKEN_ENCRYPTION_KEY, the same treatment as an access token.
 */

export type ShopifyAppCredentials = { clientId: string; apiSecret: string };

/** Tenant-scoped read for the OAuth routes, where a session already resolved
 *  the workspace. Null = this workspace has not set its app up yet. */
export async function credentialsForTenant(tenantId: string): Promise<ShopifyAppCredentials | null> {
  const row = await prismaForTenant(tenantId).shopifyAppCredential.findUnique({
    where: { tenantId },
    select: { clientId: true, apiSecret: true },
  });
  return toCredentials(row);
}

/**
 * Credentials for a webhook delivery, resolved from the shop domain in the
 * request header.
 *
 * A webhook arrives with no session, so the tenant has to be found before the
 * signature can be checked — the header selects WHICH key to try, it grants
 * nothing. A forged domain simply selects a key the forged body will not verify
 * against. This is why the lookup runs on the service client: there is no
 * tenant context to scope it with yet, and establishing one is the whole point
 * of the call.
 */
export async function credentialsForShopDomain(
  shopDomain: string
): Promise<(ShopifyAppCredentials & { tenantId: string }) | null> {
  // eslint-disable-next-line tenant-safety/require-tenant-scope -- webhook tenant resolution: shopDomain IS the tenant key here, and no session exists to scope by.
  const connection = await prismaService.shopifyConnection.findUnique({
    where: { shopDomain },
    select: { tenantId: true, tenant: { select: { shopifyAppCredential: { select: { clientId: true, apiSecret: true } } } } },
  });
  if (!connection) return null;
  const credentials = toCredentials(connection.tenant.shopifyAppCredential);
  return credentials ? { ...credentials, tenantId: connection.tenantId } : null;
}

function toCredentials(
  row: { clientId: string; apiSecret: string } | null | undefined
): ShopifyAppCredentials | null {
  if (!row) return null;
  try {
    return { clientId: row.clientId, apiSecret: decryptToken(row.apiSecret) };
  } catch {
    // Stored ciphertext that will not decrypt is almost always a
    // TOKEN_ENCRYPTION_KEY that changed between deploys. Treated as "not
    // configured" rather than thrown: every caller already has a sensible
    // not-configured path, and none of them can do anything with the error.
    return null;
  }
}
