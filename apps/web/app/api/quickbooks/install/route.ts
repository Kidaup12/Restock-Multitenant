import { NextResponse } from "next/server";
import { appCredentials, buildAuthorizeUrl } from "@wezesha/quickbooks";
import { STATE_COOKIE, STATE_COOKIE_PATH, generateOAuthState } from "@/lib/quickbooks/cookies";
import { appOrigin, quickBooksRedirectUri } from "@/lib/quickbooks/env";
import { canManageConnections, tenantActor } from "@/lib/shopify/membership";
import { withCapture } from "@/lib/observability/wrap";

/**
 * Starts the QuickBooks install: plants the state nonce in an httpOnly cookie
 * and sends the owner to Intuit to consent and pick their company. The callback
 * route completes the pair.
 *
 * Unlike Shopify — where each workspace registers its own app — QuickBooks has
 * one app for the whole platform, so the credentials come from the environment
 * rather than from the tenant.
 */
export const GET = withCapture(async () => {
  // Our configured origin, never the request's: see lib/quickbooks/env.
  const origin = appOrigin();
  const actor = await tenantActor();
  if (!actor) return NextResponse.redirect(new URL("/login", origin));
  if (!canManageConnections(actor)) {
    return NextResponse.json(
      { error: "Only owners and admins can connect QuickBooks." },
      { status: 403 }
    );
  }

  let credentials;
  try {
    credentials = appCredentials();
  } catch {
    // The platform app is not configured. Say so on the page rather than
    // sending the owner to Intuit for a handshake that cannot complete.
    return NextResponse.redirect(
      new URL("/settings/connections?qb_error=not_configured", origin)
    );
  }

  const state = generateOAuthState();
  const res = NextResponse.redirect(
    buildAuthorizeUrl({
      clientId: credentials.clientId,
      redirectUri: quickBooksRedirectUri(),
      state,
    })
  );
  // sameSite=lax survives Intuit's top-level GET redirect back.
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: origin.startsWith("https"),
    sameSite: "lax",
    path: STATE_COOKIE_PATH,
    maxAge: 600,
  });
  return res;
}, { route: "/api/quickbooks/install" });
