import { prismaForTenant, prismaService } from "@wezesha/db";
import { decryptToken } from "@wezesha/shopify";

/**
 * Per-workspace Shopify app credentials.
 *
 * Each client may register its own app and enter the client id and secret under
 * Settings → Connections. A workspace row always wins where it exists.
 *
 * There is ONE fallback, and only for the OAuth install: a Wezesha-owned app in
 * SHOPIFY_API_KEY / SHOPIFY_API_SECRET. The earlier rule forbade any fallback,
 * on the grounds that a shared key "made it impossible for a client to connect
 * its own store". That was true of the flow it was written against — the
 * CLIENT-CREDENTIALS grant, which Shopify only honours when the app and the
 * store share an organisation, so a shared app can never reach a merchant's own
 * shop. It is not true of the authorization-code install, where a single app
 * the merchant approves is how every Shopify integration works, and is what the
 * reference build does.
 *
 * So the split is deliberate: `credentialsForInstall` may fall back to the
 * platform app; `credentialsForTenant`, which feeds client-credentials minting
 * and webhook verification, still must not. Minting against a shared app would
 * reintroduce exactly the failure the old rule was guarding against.
 *
 * A workspace with neither its own row nor a configured platform app cannot run
 * an OAuth install and cannot have a webhook verified. Both fail closed, with a
 * message pointing at the form.
 *
 * The client id is stored in the clear (it travels in the authorize URL the
 * merchant's own browser visits). The secret is AES-256-GCM ciphertext under
 * TOKEN_ENCRYPTION_KEY, the same treatment as an access token.
 */

export type ShopifyAppCredentials = { clientId: string; apiSecret: string };

/**
 * The Wezesha-owned app, if this deployment has one.
 *
 * Null rather than throwing: a deployment without it is a valid state — every
 * workspace then brings its own app, exactly as before.
 */
export function platformAppCredentials(): ShopifyAppCredentials | null {
  const clientId = process.env.SHOPIFY_API_KEY;
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  if (!clientId || !apiSecret) return null;
  return { clientId, apiSecret };
}

/**
 * Credentials for the authorization-code install: the workspace's own app when
 * it has one, otherwise the platform app.
 *
 * The workspace wins on purpose. A shop that registered its own app did so for
 * a reason, and silently installing under ours would put its data behind a
 * grant it never chose.
 */
export async function credentialsForInstall(
  tenantId: string,
): Promise<ShopifyAppCredentials | null> {
  return (await credentialsForTenant(tenantId)) ?? platformAppCredentials();
}

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
