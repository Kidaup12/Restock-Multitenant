import { NextResponse, type NextRequest } from "next/server";
import { buildAuthorizeUrl, generateOAuthState, isValidShopDomain } from "@wezesha/shopify";
import { STATE_COOKIE, STATE_COOKIE_PATH } from "@/lib/shopify/cookies";
import { credentialsForInstall } from "@/lib/shopify/credentials";
import { shopifyAppUrl } from "@/lib/shopify/env";
import { canManageConnections, tenantActor } from "@/lib/shopify/membership";
import { withCapture } from "@/lib/observability/wrap";

/**
 * Kicks off the per-store OAuth install: validates the shop domain, plants the
 * state nonce (bound to the shop) in an httpOnly cookie, and redirects the
 * browser to the store's authorize page. The callback route completes the pair.
 */
export const GET = withCapture(async (req: NextRequest) => {
  // Redirects must be built from our configured public origin, never from the
  // incoming request: behind a proxy that resolves to the container's own
  // listener. Same value the callback uses, so the handshake cannot disagree.
  const appUrl = shopifyAppUrl();
  const actor = await tenantActor();
  if (!actor) return NextResponse.redirect(new URL("/login", appUrl));
  if (!canManageConnections(actor)) {
    return NextResponse.json({ error: "Only owners and admins can connect a store." }, { status: 403 });
  }

  const shop = req.nextUrl.searchParams.get("shop")?.trim().toLowerCase() ?? "";
  if (!isValidShopDomain(shop)) {
    return NextResponse.json({ error: "shop must be a *.myshopify.com domain" }, { status: 400 });
  }

  // This workspace's own app — there is no platform app to fall back to.
    // The platform app is the fallback here, and only here: the install is an
  // authorization-code grant the merchant approves, which works on any store.
  const credentials = await credentialsForInstall(actor.tenantId);
  if (!credentials) {
    return NextResponse.redirect(
      new URL("/settings/connections?error=no_app_credentials", appUrl)
    );
  }

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
