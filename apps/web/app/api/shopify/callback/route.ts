import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { Prisma, prismaForTenantTx } from "@wezesha/db";
import {
  encryptToken,
  exchangeCodeForToken,
  isValidShopDomain,
  verifyOAuthHmac,
} from "@wezesha/shopify";
import { STATE_COOKIE, STATE_COOKIE_PATH } from "@/lib/shopify/cookies";
import { credentialsForTenant } from "@/lib/shopify/credentials";
import { shopifyAppUrl } from "@/lib/shopify/env";
import { canManageConnections, tenantActor } from "@/lib/shopify/membership";
import { enqueueShopifySync } from "@/lib/shopify/queue";
import { resetCursorsOnStoreChange } from "@/lib/shopify/store-switch";
import { withCapture } from "@/lib/observability/wrap";

/**
 * OAuth callback: state + HMAC verification, code→offline-token exchange,
 * encrypted upsert of the ACTIVE tenant's connection, initial sync enqueue.
 * Browser-facing, so failures land back on the connections page with an error
 * code rather than a bare status page. What escapes that (the re-raised upsert
 * failure below) is captured and answered 500 — the route tag is the path, so
 * neither the code nor the hmac in the query string travels with it.
 */

function done(origin: string, param: "connected" | "error", value: string): NextResponse {
  const res = NextResponse.redirect(new URL(`/settings/connections?${param}=${value}`, origin));
  res.cookies.set(STATE_COOKIE, "", { maxAge: 0, path: STATE_COOKIE_PATH });
  return res;
}

function timingSafeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export const GET = withCapture(async (req: NextRequest) => {
  // Our own public origin, not the request's. Behind a proxy the incoming
  // request resolves to the container's listener, which sent a merchant to
  // https://localhost:8080/settings/connections after a successful connect.
  // This is the same value the install route builds redirect_uri from, so the
  // two halves of the handshake cannot disagree.
  const origin = shopifyAppUrl();
  const actor = await tenantActor();
  if (!actor) return NextResponse.redirect(new URL("/login", origin));
  if (!canManageConnections(actor)) return done(origin, "error", "forbidden");

  const params = req.nextUrl.searchParams;
  const shop = params.get("shop")?.trim().toLowerCase() ?? "";
  const state = params.get("state") ?? "";
  const code = params.get("code") ?? "";

  // State: must match the nonce we planted, for the shop we planted it for.
  const cookie = req.cookies.get(STATE_COOKIE)?.value ?? "";
  const sep = cookie.indexOf(":");
  const cookieState = sep === -1 ? "" : cookie.slice(0, sep);
  const cookieShop = sep === -1 ? "" : cookie.slice(sep + 1);
  if (!state || !cookieState || !timingSafeEq(state, cookieState)) {
    return done(origin, "error", "invalid_state");
  }
  if (!isValidShopDomain(shop) || shop !== cookieShop) return done(origin, "error", "invalid_shop");

  // The same workspace credentials the install redirect was built from. If they
  // have been cleared mid-install there is nothing to verify the callback with,
  // and no platform app to fall back to.
  const credentials = await credentialsForTenant(actor.tenantId);
  if (!credentials) return done(origin, "error", "no_app_credentials");

  const { clientId, apiSecret } = credentials;
  if (!verifyOAuthHmac(params, apiSecret)) return done(origin, "error", "invalid_hmac");
  if (!code) return done(origin, "error", "missing_code");

  let token: { accessToken: string; scopes: string };
  try {
    token = await exchangeCodeForToken({ shop, clientId, clientSecret: apiSecret, code });
  } catch (err) {
    console.error("shopify callback: token exchange failed", err);
    return done(origin, "error", "exchange_failed");
  }

  try {
    await prismaForTenantTx(actor.tenantId, async (tx) => {
      // Authorising a DIFFERENT store leaves the previous one's high-water marks
      // behind, and the next sync would run as a delta against a store we have
      // never pulled. Same transaction as the upsert.
      await resetCursorsOnStoreChange(tx, actor.tenantId, shop);
      await tx.shopifyConnection.upsert({
        where: { tenantId: actor.tenantId },
        create: {
          tenantId: actor.tenantId,
          shopDomain: shop,
          accessToken: encryptToken(token.accessToken),
          scopes: token.scopes,
        },
        update: {
          shopDomain: shop,
          accessToken: encryptToken(token.accessToken),
          scopes: token.scopes,
          installedAt: new Date(),
          uninstalledAt: null,
          // A fresh token is the reconnect the auth-failure pause was waiting for.
          // Without this the scheduler keeps skipping a store that now works.
          authFailureCount: 0,
          syncPausedAt: null,
          lastAuthError: null,
          lastAuthErrorAt: null,
        },
      });
    });
  } catch (err) {
    // shopDomain is globally unique — another workspace already owns this store.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return done(origin, "error", "shop_taken");
    }
    throw err;
  }

  try {
    await enqueueShopifySync(actor.tenantId);
  } catch (err) {
    // The connection is saved; a missed initial enqueue is recoverable from the
    // Sync now button.
    console.error("shopify callback: initial sync enqueue failed", err);
  }

  return done(origin, "connected", "1");
});
