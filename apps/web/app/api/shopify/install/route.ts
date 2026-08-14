import { NextResponse, type NextRequest } from "next/server";
import { buildAuthorizeUrl, generateOAuthState, isValidShopDomain } from "@wezesha/shopify";
import { STATE_COOKIE, STATE_COOKIE_PATH } from "@/lib/shopify/cookies";
import { credentialsForTenant } from "@/lib/shopify/credentials";
import { shopifyAppUrl } from "@/lib/shopify/env";
import { canManageConnections, tenantActor } from "@/lib/shopify/membership";
import { withCapture } from "@/lib/observability/wrap";

/**
 * Kicks off the per-store OAuth install: validates the shop domain, plants the
 * state nonce (bound to the shop) in an httpOnly cookie, and redirects the
 * browser to the store's authorize page. The callback route completes the pair.
 */
export const GET = withCapture(async (req: NextRequest) => {
  const actor = await tenantActor();
  if (!actor) return NextResponse.redirect(new URL("/login", req.nextUrl.origin));
  if (!canManageConnections(actor)) {
    return NextResponse.json({ error: "Only owners and admins can connect a store." }, { status: 403 });
  }

  const shop = req.nextUrl.searchParams.get("shop")?.trim().toLowerCase() ?? "";
  if (!isValidShopDomain(shop)) {
    return NextResponse.json({ error: "shop must be a *.myshopify.com domain" }, { status: 400 });
  }

  // This workspace's own app — there is no platform app to fall back to.
  const credentials = await credentialsForTenant(actor.tenantId);
  if (!credentials) {
    return NextResponse.redirect(
      new URL("/settings/connections?error=no_app_credentials", req.nextUrl.origin)
    );
  }

  const appUrl = shopifyAppUrl();
  const state = generateOAuthState();
  const res = NextResponse.redirect(
    buildAuthorizeUrl({
      shop,
      clientId: credentials.clientId,
      redirectUri: `${appUrl}/api/shopify/callback`,
      state,
    })
  );
  // Bound to the shop so the callback can verify the SAME store came back.
  // sameSite=lax survives Shopify's top-level GET redirect home.
  res.cookies.set(STATE_COOKIE, `${state}:${shop}`, {
    httpOnly: true,
    secure: appUrl.startsWith("https"),
    sameSite: "lax",
    maxAge: 600,
    path: STATE_COOKIE_PATH,
  });
  return res;
});
