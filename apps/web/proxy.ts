import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

/**
 * Optimistic auth gate for the app shell (Next 16's proxy, formerly
 * middleware): no session cookie → straight to /login without rendering
 * anything. Cookie presence is NOT validation — the real check (a
 * Session-table lookup) happens in the shell layout via requireSession().
 * This just keeps signed-out navigation cheap.
 */
export function proxy(request: NextRequest) {
  if (!getSessionCookie(request)) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
}

export const config = {
  // The (shell) route group, plus /profile which lives inside it.
  matcher: [
    "/today/:path*",
    "/plan/:path*",
    "/orders/:path*",
    "/receiving",
    "/stock/:path*",
    "/products/:path*",
    "/getting-started",
    "/inventory/:path*",
    "/sales/:path*",
    "/insights/:path*",
    "/settings/:path*",
    "/more/:path*",
    "/profile/:path*",
  ],
};
