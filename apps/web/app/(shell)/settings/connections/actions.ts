"use server";

import { revalidatePath } from "next/cache";
import { Prisma, prismaForTenant, prismaForTenantTx, prismaService } from "@wezesha/db";
import {
  createShopifyClient,
  decryptToken,
  encryptToken,
  isValidShopDomain,
  mintAdminToken,
  probeConnection,
  ShopifyAuthError,
  ShopifyGrantError,
  ShopifyRateLimitedError,
} from "@wezesha/shopify";
import { credentialsForTenant } from "@/lib/shopify/credentials";
import { enqueueShopifySync } from "@/lib/shopify/queue";
import { tenantActor, canManageConnections } from "@/lib/shopify/membership";
import { resetCursorsOnStoreChange } from "@/lib/shopify/store-switch";

/**
 * Connect a Shopify store by pasting an Admin API access token.
 *
 * The OAuth path (/api/shopify/install) needs OUR app's client id and secret,
 * which are one set of environment variables for the whole platform. That is
 * fine for stores we install ourselves and useless for anyone else: a shop
 * cannot connect its own store, which is what stalled testing entirely.
 *
 * A shop building its own custom app under Settings → Apps → Develop apps gets
 * an Admin API access token directly. There is no authorization round trip to
 * run, no redirect URL to register and no app review to wait for — the token IS
 * the credential. Pasting it is the shortest path from "I have a store" to
 * "the catalogue is syncing", and it is entirely in the shop's hands.
 *
 * The trade, recorded so nobody rediscovers it: a custom app of the shop's own
 * cannot send us webhooks we could verify, because the signing secret is theirs
 * and we never see it. Token-mode stores therefore live on the scheduled sync.
 * That is the existing behaviour for every store today anyway — SHOPIFY_APP_URL
 * is unset on the worker, so no webhooks are registered for anyone.
 */

export type ConnectResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

const err = (error: string): ConnectResult => ({ ok: false, error });

/** Shopify's own prefix for an Admin API access token from a custom app. The
 *  check is a courtesy, not a security boundary — the probe is the real test —
 *  but it catches the common paste of an API key or a storefront token. */
const ADMIN_TOKEN_RE = /^shpat_[A-Za-z0-9]+$/;

async function actorContext() {
  const actor = await tenantActor();
  if (!actor) return null;
  if (!canManageConnections(actor)) return null;
  return actor;
}

function audit(tenantId: string, action: string, userId: string, meta: Prisma.InputJsonObject) {
  return prismaService.auditEvent.create({
    data: { tenantId, entity: "ShopifyConnection", entityId: tenantId, action, actorUserId: userId, meta },
  });
}

export async function connectShopifyWithToken(input: {
  shopDomain: string;
  accessToken: string;
}): Promise<ConnectResult> {
  const actor = await actorContext();
  if (!actor) return err("Only owners and admins can connect a store.");

  const shopDomain = input.shopDomain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!isValidShopDomain(shopDomain)) {
    return err("That does not look like a store address. It should end in .myshopify.com");
  }
  const accessToken = input.accessToken.trim();
  if (!ADMIN_TOKEN_RE.test(accessToken)) {
    return err("That does not look like an Admin API access token. It should start with shpat_.");
  }

  // Probe BEFORE writing anything. A stored token that has never been proven is
  // a connection the shop believes in and the worker cannot use — the failure
  // then arrives as a sync error a quarter of an hour later, to nobody.
  let probe;
  try {
    probe = await probeConnection(createShopifyClient({ shopDomain, accessToken }));
  } catch (e) {
    if (e instanceof ShopifyAuthError) {
      return err(
        "Shopify refused that token. Check it was copied in full from the same store, and that the app is installed."
      );
    }
    if (e instanceof ShopifyRateLimitedError) {
      return err("The store is rate limiting us right now. Try again in a minute.");
    }
    return err(`Could not reach that store: ${(e as Error).message}`);
  }

  if (probe.missingScopes.length > 0) {
    return err(
      `The token is valid but is missing ${probe.missingScopes.join(", ")}. Add those scopes to the app in your Shopify admin, then reinstall it and paste the new token.`
    );
  }

  try {
    await prismaForTenantTx(actor.tenantId, async (tx) => {
      // A different store means the stored high-water marks describe data this
      // workspace no longer has. Same transaction as the upsert: the two must
      // not be able to disagree.
      await resetCursorsOnStoreChange(tx, actor.tenantId, shopDomain);
      await tx.shopifyConnection.upsert({
        where: { tenantId: actor.tenantId },
        create: {
          tenantId: actor.tenantId,
          shopDomain,
          accessToken: encryptToken(accessToken),
          // What the store actually granted, not what we asked for.
          scopes: probe.grantedScopes.join(","),
          authMode: "token",
        },
        update: {
          shopDomain,
          accessToken: encryptToken(accessToken),
          scopes: probe.grantedScopes.join(","),
          authMode: "token",
          installedAt: new Date(),
          uninstalledAt: null,
          // A token that just proved itself clears any earlier give-up state.
          authFailureCount: 0,
          syncPausedAt: null,
          lastAuthError: null,
          lastAuthErrorAt: null,
        },
      });
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      // shopDomain is globally unique. This is the first thing someone hits when
      // re-pasting after a failed attempt in another workspace, so it gets a
      // sentence rather than a stack trace.
      return err("That store is already connected to a different workspace.");
    }
    throw e;
  }

  // The token itself never reaches the ledger — only that a store was connected
  // and how.
  await audit(actor.tenantId, "shopify_connected_with_token", actor.userId, {
    shopDomain,
    scopes: probe.grantedScopes,
  });

  try {
    await enqueueShopifySync(actor.tenantId);
  } catch (e) {
    // The connection is saved; a missed first enqueue is recoverable from the
    // Sync now button and from the next scheduled tick.
    console.error("connect with token: initial sync enqueue failed", e);
  }

  revalidatePath("/settings/connections");
  const where = probe.shopName ? ` to ${probe.shopName}` : "";
  return { ok: true, message: `Connected${where}. The first sync is running in the background.` };
}

/**
 * Save this workspace's own Shopify app credentials.
 *
 * Wezesha holds no Shopify app any more: there is no SHOPIFY_API_KEY and no
 * SHOPIFY_API_SECRET anywhere, so these are the only credentials the OAuth
 * install and the webhook verifier will use for this shop. A workspace that has
 * not set them cannot do either, which is the point — one shared app across
 * every client is exactly what made a client unable to connect its own store.
 *
 * The secret is never read back to anyone. The settings screen renders a
 * "configured" flag, the same way the till-feed secret is handled.
 */
export async function saveShopifyAppCredentials(input: {
  clientId: string;
  apiSecret: string;
}): Promise<ConnectResult> {
  const actor = await actorContext();
  if (!actor) return err("Only owners and admins can change Shopify app credentials.");

  const clientId = input.clientId.trim();
  const apiSecret = input.apiSecret.trim();
  if (!clientId) return err("The client ID is required.");

  const db = prismaForTenant(actor.tenantId);
  const existing = await db.shopifyAppCredential.findUnique({
    where: { tenantId: actor.tenantId },
    select: { id: true },
  });

  // An empty secret box means "leave the stored one alone" — it is the only
  // thing the form can offer, since the secret is never shown again. With no
  // stored secret to keep there is nothing to save, and saying so is the whole
  // point: a disabled button that silently does nothing is how a workspace ends
  // up believing it is configured when it is not.
  if (!apiSecret && !existing) {
    return err("Paste the API secret key as well — there is no stored one to keep.");
  }
  // Shopify renders both as 32-character hex. Not a security boundary — the
  // store rejects a wrong one anyway — but it catches the two fields being
  // pasted the wrong way round, or a token pasted into either.
  if (!/^[A-Za-z0-9_-]{8,}$/.test(clientId)) return err("That client ID does not look right.");
  if (apiSecret && !/^[A-Za-z0-9_-]{8,}$/.test(apiSecret)) {
    return err("That API secret does not look right.");
  }

  await db.shopifyAppCredential.upsert({
    where: { tenantId: actor.tenantId },
    // A blank secret box on an already-configured workspace changes only the
    // client id; the stored ciphertext is left exactly as it is.
    create: { tenantId: actor.tenantId, clientId, apiSecret: encryptToken(apiSecret) },
    update: { clientId, ...(apiSecret ? { apiSecret: encryptToken(apiSecret) } : {}) },
  });
  // Neither value reaches the ledger — only that they changed.
  await audit(actor.tenantId, "shopify_app_credentials_saved", actor.userId, {
    replaced: Boolean(existing),
  });

  revalidatePath("/settings/connections");
  return {
    ok: true,
    message: existing
      ? "App credentials updated. New installs will use them."
      : "App credentials saved. You can now connect a store with your own app.",
  };
}

/** Remove this workspace's app credentials. Leaves any connected store alone —
 *  a store already connected keeps syncing on its stored access token. */
export async function clearShopifyAppCredentials(): Promise<ConnectResult> {
  const actor = await actorContext();
  if (!actor) return err("Only owners and admins can change Shopify app credentials.");

  const db = prismaForTenant(actor.tenantId);
  await db.shopifyAppCredential.deleteMany({ where: { tenantId: actor.tenantId } });
  await audit(actor.tenantId, "shopify_app_credentials_cleared", actor.userId, {});

  revalidatePath("/settings/connections");
  return { ok: true, message: "App credentials removed." };
}

/**
 * Answer "is this store actually reachable right now", on demand.
 *
 * The question this replaces is a bad one: today the only way to find out is to
 * press Sync now and wait for a run to fail, which reports the fault in worker
 * language ("Shopify auth failed (403)") on a screen that also has to explain
 * fifteen other things. A token can be dead for days before anyone notices —
 * both production stores were, and neither said so anywhere a shop could see.
 *
 * Deliberately no writes. This is a read someone presses when they are already
 * unsure; making it mutate state would mean an unlucky press could pause syncs
 * or clear a pause on evidence nobody asked it to gather.
 */
export async function testShopifyConnection(): Promise<ConnectResult> {
  const actor = await actorContext();
  if (!actor) return err("Only owners and admins can test a store connection.");

  const db = prismaForTenant(actor.tenantId);
  const connection = await db.shopifyConnection.findFirst();
  if (!connection) return err("No store is connected yet.");
  if (connection.uninstalledAt) {
    return err("This store is disconnected. Reconnect it before testing.");
  }

  /**
   * Test the credential the SYNC would use, not whatever token happens to be
   * stored.
   *
   * This used to decrypt `connection.accessToken` and probe with it. On a
   * workspace connected by app credentials that is a client-credentials token
   * minted days ago and dead within about a day — the worker never presents it,
   * because `resolveAccessToken` mints a fresh one every run. So the button
   * reported "the store rejected our access token" over a store syncing
   * perfectly, and sent whoever pressed it to reconnect a connection that was
   * fine. Verified on a live workspace: the probe failed on a token from 4 Aug
   * while that morning's sync had succeeded.
   *
   * The order below mirrors the worker exactly. If the two ever part company
   * again, this control goes back to answering a question nobody asked.
   */
  const credentials = await credentialsForTenant(actor.tenantId);
  let accessToken: string;
  if (credentials) {
    try {
      accessToken = (
        await mintAdminToken(connection.shopDomain, {
          clientId: credentials.clientId,
          clientSecret: credentials.apiSecret,
        })
      ).accessToken;
    } catch (e) {
      if (e instanceof ShopifyGrantError) {
        return err(
          `${connection.shopDomain} refused this workspace's app credentials. Check the client ID and secret above — the store itself may be fine.`
        );
      }
      return err(`Could not reach ${connection.shopDomain}: ${(e as Error).message}`);
    }
  } else if (connection.authMode === "token") {
    try {
      accessToken = decryptToken(connection.accessToken);
    } catch {
      // The stored ciphertext cannot be read — almost always TOKEN_ENCRYPTION_KEY
      // differing between deploys. Worth saying plainly; no amount of retrying
      // helps, and the sync would fail the same way with less explanation.
      return err("The stored token could not be read. Reconnect the store to store a fresh one.");
    }
  } else {
    // An OAuth token with no credentials to renew it: the sync refuses this
    // workspace outright, so the honest answer is the same one it gives.
    return err(
      `${connection.shopDomain} has no Shopify app credentials in this workspace, so nothing can be minted to reach it. Add the client ID and secret above, or connect the store with an Admin API token.`
    );
  }

  let probe;
  try {
    probe = await probeConnection(createShopifyClient({ shopDomain: connection.shopDomain, accessToken }));
  } catch (e) {
    if (e instanceof ShopifyAuthError) {
      return err(
        `${connection.shopDomain} rejected our access token. Reconnect the store, or regenerate the token in your Shopify admin.`
      );
    }
    if (e instanceof ShopifyRateLimitedError) {
      return err("The store is rate limiting us right now. Try again in a minute.");
    }
    return err(`Could not reach ${connection.shopDomain}: ${(e as Error).message}`);
  }

  if (probe.missingScopes.length > 0) {
    return err(
      `Connected, but the app is missing ${probe.missingScopes.join(", ")}. Add those scopes in your Shopify admin and reconnect, or stock and sales will not sync fully.`
    );
  }

  const name = probe.shopName ?? connection.shopDomain;
  const currency = probe.currencyCode ? `, trading in ${probe.currencyCode}` : "";
  return { ok: true, message: `Working. Connected to ${name}${currency}.` };
}
