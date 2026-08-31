import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

const saveConnection = vi.fn();
const exchangeCodeForToken = vi.fn();
let actor: { userId: string; tenantId: string; role: string } | null = null;

vi.mock("@/lib/quickbooks/connection", () => ({
  saveConnection: (...args: unknown[]) => saveConnection(...args),
}));
vi.mock("@/lib/shopify/membership", () => ({
  tenantActor: async () => actor,
  canManageConnections: (a: { role: string }) => a.role === "OWNER" || a.role === "ADMIN",
}));
vi.mock("@wezesha/quickbooks", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  exchangeCodeForToken: (...args: unknown[]) => exchangeCodeForToken(...args),
}));

import { NextRequest } from "next/server";
// Imported at collection time: the first dynamic import of this route pulls in
// auth + Prisma module init, which exceeded the per-test timeout.
import { GET as callbackGET } from "../app/api/quickbooks/callback/route";
import { QuickBooksConnectionCard } from "../app/(shell)/settings/connections/quickbooks-connection-card";

const ORIGIN = "https://app.example.com";
process.env.BETTER_AUTH_URL = ORIGIN;

type Props = Parameters<typeof QuickBooksConnectionCard>[0];
const base: Props = { connection: null, canManage: true, configured: true, notice: null };
const render = (over: Partial<Props> = {}) =>
  renderToStaticMarkup(<QuickBooksConnectionCard {...base} {...over} />);

describe("the QuickBooks card only offers what can actually work", () => {
  it("offers Connect when the platform app is configured", () => {
    expect(render()).toContain("/api/quickbooks/install");
  });

  it("does NOT offer Connect when the app has no credentials", () => {
    const html = render({ configured: false });
    // The negative control: without this assertion the test above passes even
    // if the button is always rendered.
    expect(html).not.toContain("/api/quickbooks/install");
    expect(html).toContain("not switched on for this deployment");
  });

  it("offers Disconnect instead of Connect once connected", () => {
    const html = render({
      connection: {
        realmId: "9341457797609723",
        connectedAt: "2026-08-29 10:00",
        disconnectedAt: null,
        syncPausedAt: null,
        lastAuthError: null,
      },
    });
    expect(html).toContain("Disconnect");
    expect(html).not.toContain("/api/quickbooks/install");
  });

  it("offers nothing to a member who cannot manage connections", () => {
    const html = render({ canManage: false });
    expect(html).not.toContain("/api/quickbooks/install");
    expect(html).toContain("Only owners and admins");
  });
});

/** The callback's state nonce is the whole CSRF boundary, so every case here
 *  asserts that nothing was SAVED — not merely that a redirect happened. */
describe("the QuickBooks callback refuses anything it cannot vouch for", () => {
  beforeEach(() => {
    saveConnection.mockReset();
    exchangeCodeForToken.mockReset();
    actor = { userId: "u1", tenantId: "t1", role: "OWNER" };
  });

  const call = (query: string, cookie?: string) => {
    const req = new NextRequest(`${ORIGIN}/api/quickbooks/callback?${query}`, {
      headers: cookie ? { cookie: `quickbooks_oauth_state=${cookie}` } : {},
    });
    return callbackGET(req);
  };

  it("rejects a callback whose state does not match the cookie", async () => {
    const res = await call("code=c&realmId=r&state=attacker", "the-real-nonce");
    expect(res.headers.get("location")).toContain("qb_error=invalid_state");
    expect(saveConnection).not.toHaveBeenCalled();
  });

  it("rejects a callback with no state cookie at all", async () => {
    const res = await call("code=c&realmId=r&state=whatever");
    expect(res.headers.get("location")).toContain("qb_error=invalid_state");
    expect(saveConnection).not.toHaveBeenCalled();
  });

  it("rejects a token pair with no company id", async () => {
    const res = await call("code=c&state=n", "n");
    expect(res.headers.get("location")).toContain("qb_error=missing_realm");
    expect(saveConnection).not.toHaveBeenCalled();
  });

  it("refuses a member who cannot manage connections", async () => {
    actor = { userId: "u2", tenantId: "t1", role: "STAFF" };
    const res = await call("code=c&realmId=r&state=n", "n");
    expect(res.headers.get("location")).toContain("qb_error=forbidden");
    expect(saveConnection).not.toHaveBeenCalled();
  });

  it("saves the connection when state, code and company all check out", async () => {
    exchangeCodeForToken.mockResolvedValue({
      accessToken: "a",
      refreshToken: "r",
      accessTokenExpiresAt: new Date(),
      refreshTokenExpiresAt: new Date(),
      scopes: "com.intuit.quickbooks.accounting",
    });
    const res = await call("code=c&realmId=9341457797609723&state=n", "n");
    expect(res.headers.get("location")).toContain("qb=connected");
    expect(saveConnection).toHaveBeenCalledWith("t1", "9341457797609723", expect.anything());
  });

  it("builds redirects from BETTER_AUTH_URL, not the request host", async () => {
    const req = new NextRequest("https://localhost:8080/api/quickbooks/callback?code=c&state=x", {
      headers: { cookie: "quickbooks_oauth_state=y" },
    });
    const res = await callbackGET(req);
    // The bug the Shopify callback shipped with: a proxy makes the request
    // resolve to the container itself and merchants land on localhost.
    expect(res.headers.get("location")).toContain(ORIGIN);
    expect(res.headers.get("location")).not.toContain("localhost:8080");
  });
});
