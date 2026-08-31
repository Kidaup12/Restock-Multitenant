import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { QuickBooksAuthError, exchangeCodeForToken } from "@wezesha/quickbooks";
import { STATE_COOKIE, STATE_COOKIE_PATH } from "@/lib/quickbooks/cookies";
import { appOrigin, quickBooksRedirectUri } from "@/lib/quickbooks/env";
import { saveConnection } from "@/lib/quickbooks/connection";
import { canManageConnections, tenantActor } from "@/lib/shopify/membership";
import { withCapture } from "@/lib/observability/wrap";

/**
 * Completes the QuickBooks install: state check, code→token exchange, encrypted
 * upsert of the ACTIVE workspace's connection.
 *
 * Browser-facing, so failures land back on the connections page with a code
 * rather than a bare status page — and the code never travels in the message.
 */

function done(origin: string, param: "qb" | "qb_error", value: string): NextResponse {
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
  // Our configured origin, never the request's — the same rule the Shopify
  // callback had to learn: behind a proxy the request is the container itself.
  const origin = appOrigin();
  const actor = await tenantActor();
  if (!actor) return NextResponse.redirect(new URL("/login", origin));
  if (!canManageConnections(actor)) return done(origin, "qb_error", "forbidden");

  const params = req.nextUrl.searchParams;
  const code = params.get("code");
  const realmId = params.get("realmId");
  const state = params.get("state") ?? "";
  const cookieState = req.cookies.get(STATE_COOKIE)?.value ?? "";

  // The nonce proves this callback belongs to an install THIS browser started.
  if (!cookieState || !state || !timingSafeEq(state, cookieState)) {
    return done(origin, "qb_error", "invalid_state");
  }
  if (!code) return done(origin, "qb_error", "missing_code");
  // Without a company id there is nothing to read later, so a token pair on its
  // own is not a usable connection.
  if (!realmId) return done(origin, "qb_error", "missing_realm");

  let tokens;
  try {
    tokens = await exchangeCodeForToken({ code, redirectUri: quickBooksRedirectUri() });
  } catch (err) {
    if (err instanceof QuickBooksAuthError) return done(origin, "qb_error", "exchange_failed");
    throw err;
  }

  await saveConnection(actor.tenantId, realmId, tokens);
  return done(origin, "qb", "connected");
});
