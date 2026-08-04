"use server";

import { revalidatePath } from "next/cache";
import { Prisma, prismaForTenant, prismaService } from "@wezesha/db";
import {
  createShopifyClient,
  encryptToken,
  isValidShopDomain,
  probeConnection,
  ShopifyAuthError,
  ShopifyRateLimitedError,
} from "@wezesha/shopify";
import { enqueueShopifySync } from "@/lib/shopify/queue";
import { tenantActor, canManageConnections } from "@/lib/shopify/membership";

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
    const db = prismaForTenant(actor.tenantId);
    await db.shopifyConnection.upsert({
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
