import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pointing a workspace at a DIFFERENT store must drop that workspace's Shopify
 * ingest cursors.
 *
 * The cursors are high-water marks for one store's data. Left in place across a
 * store swap, the next sync runs as a delta against a store it has never pulled:
 * orders are fetched only from the old store's mark minus the overlap window,
 * so everything the new store sold before that moment is never backfilled and
 * never will be — the orders cursor is only re-read, never cleared, and run
 * rates are then computed on a history that silently stops. (The products
 * cursor self-heals: the daily full-sync cron deletes it. Nothing clears the
 * other two.)
 *
 * The mirror case matters as much: re-pasting a token for the SAME store is
 * routine credential maintenance, and forcing a full re-pull every time someone
 * refreshes a token is its own kind of damage.
 */

const dbUrl = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(dbUrl);

const authState: { session: { user: { id: string } } | null; membership: unknown } = {
  session: { user: { id: "cursor-reset-user" } },
  membership: null,
};

vi.mock("@/lib/auth", () => ({
  getSession: async () => authState.session,
  requireSession: async () => authState.session,
  activeMembership: async () => authState.membership,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/shopify/queue", () => ({
  enqueueShopifySync: async () => ({ enqueued: true }),
  publishRealtime: async () => {},
}));

// Everything that talks to Shopify is stubbed: the point of this suite is what
// the two write paths do to the database, not what the store answers.
vi.mock("@wezesha/shopify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@wezesha/shopify")>();
  return {
    ...actual,
    createShopifyClient: () => ({ shopDomain: "stub", graphql: async () => ({}) }),
    probeConnection: async () => ({
      shopName: "Amara Beauty",
      currencyCode: "KES",
      grantedScopes: ALL_SCOPES,
      missingScopes: [],
    }),
    verifyOAuthHmac: () => true,
    exchangeCodeForToken: async () => ({ accessToken: OAUTH_TOKEN, scopes: ALL_SCOPES.join(",") }),
  };
});

import { NextRequest } from "next/server";
import { prismaService } from "@wezesha/db";
import { encryptToken } from "@wezesha/shopify";
import { connectShopifyWithToken } from "@/app/(shell)/settings/connections/actions";
import { GET as callback } from "@/app/api/shopify/callback/route";
import { STATE_COOKIE } from "@/lib/shopify/cookies";

const SLUG = "cursor-reset-tenant";
const GOOD_TOKEN = "shpat_cursorreset0123456789";
const OAUTH_TOKEN = "shpat_oauthcursorreset0123";
const ALL_SCOPES = ["read_products", "read_inventory", "read_orders", "read_locations"];
const FIRST_SHOP = "cursor-reset-one.myshopify.com";
const SECOND_SHOP = "cursor-reset-two.myshopify.com";
const CURSOR_AT = new Date("2026-08-01T00:00:00.000Z");

describe.skipIf(!runnable)("reconnecting to a different store resets the cursors (local db)", () => {
  let tenantId = "";

  beforeAll(async () => {
    process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
    await cleanup();
    const tenant = await prismaService.tenant.create({
      data: { name: SLUG, slug: SLUG, plan: "growth" },
    });
    tenantId = tenant.id;
    authState.session = { user: { id: "cursor-reset-user" } };
    authState.membership = {
      id: `m-${tenantId}`,
      tenantId,
      role: "OWNER",
      permissions: null,
      tenant: { slug: SLUG, name: SLUG, currency: "KES" },
    };
    // The OAuth path verifies the callback with the workspace's own app
    // credentials; there is no platform fallback to lean on.
    await prismaService.shopifyAppCredential.create({
      data: { tenantId, clientId: "cursor-reset-client", apiSecret: encryptToken("cursor-reset-secret") },
    });
  }, 60_000);

  beforeEach(async () => {
    await prismaService.shopifyConnection.deleteMany({ where: { tenantId } });
    await prismaService.ingestCursor.deleteMany({ where: { tenantId } });
  });

  afterAll(cleanup);

  async function cleanup() {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
  }

  /** The state the workspace is in after a store has synced at least once. */
  async function connectedWithCursors(shopDomain: string) {
    const res = await connectShopifyWithToken({ shopDomain, accessToken: GOOD_TOKEN });
    expect(res).toMatchObject({ ok: true });
    await prismaService.ingestCursor.createMany({
      data: ["products", "orders", "inventory"].map((resource) => ({
        tenantId,
        source: "shopify",
        resource,
        cursor: CURSOR_AT,
      })),
    });
  }

  const cursors = () =>
    prismaService.ingestCursor.findMany({
      where: { tenantId },
      select: { source: true, resource: true, cursor: true },
      orderBy: [{ source: "asc" }, { resource: "asc" }],
    });

  /** An OAuth callback that passes state, hmac and code — the checks above it
   *  are covered elsewhere; this suite is about the upsert underneath. */
  function callbackRequest(shop: string): NextRequest {
    const state = "cursor-reset-state-nonce";
    return new NextRequest(
      `http://connect.test/api/shopify/callback?shop=${shop}&state=${state}&code=auth-code&hmac=stub`,
      { headers: { cookie: `${STATE_COOKIE}=${state}:${shop}` } }
    );
  }

  describe("pasted token", () => {
    it("drops every cursor when the workspace is pointed at another store", async () => {
      await connectedWithCursors(FIRST_SHOP);
      expect(await cursors()).toHaveLength(3);

      const res = await connectShopifyWithToken({
        shopDomain: SECOND_SHOP,
        accessToken: GOOD_TOKEN,
      });
      expect(res).toMatchObject({ ok: true });

      // Anything left here is a delta against a store we have never pulled.
      expect(await cursors()).toEqual([]);
      const row = await prismaService.shopifyConnection.findUnique({ where: { tenantId } });
      expect(row!.shopDomain).toBe(SECOND_SHOP);
    });

    it("keeps the cursors when the same store's token is re-pasted", async () => {
      await connectedWithCursors(FIRST_SHOP);
      const before = await cursors();

      const res = await connectShopifyWithToken({
        shopDomain: FIRST_SHOP,
        accessToken: GOOD_TOKEN,
      });
      expect(res).toMatchObject({ ok: true });

      // Refreshing a credential is routine. Dropping the marks here would mean
      // a full catalogue pull and a year of orders re-fetched every time.
      expect(await cursors()).toEqual(before);
    });

    it("treats a first-ever connect as nothing to reset", async () => {
      const res = await connectShopifyWithToken({ shopDomain: FIRST_SHOP, accessToken: GOOD_TOKEN });
      expect(res).toMatchObject({ ok: true });
      expect(await cursors()).toEqual([]);
    });

    it("leaves cursors belonging to another feed alone", async () => {
      await connectedWithCursors(FIRST_SHOP);
      await prismaService.ingestCursor.create({
        data: { tenantId, source: "till", resource: "sales", cursor: CURSOR_AT },
      });

      await connectShopifyWithToken({ shopDomain: SECOND_SHOP, accessToken: GOOD_TOKEN });

      // The till feed did not change store. Its high-water mark is still true.
      expect(await cursors()).toEqual([
        { source: "till", resource: "sales", cursor: CURSOR_AT },
      ]);
    });
  });

  describe("oauth callback", () => {
    it("drops every cursor when the callback lands on another store", async () => {
      await connectedWithCursors(FIRST_SHOP);
      expect(await cursors()).toHaveLength(3);

      const res = await callback(callbackRequest(SECOND_SHOP));
      expect(res.headers.get("location")).toContain("connected=1");

      expect(await cursors()).toEqual([]);
      const row = await prismaService.shopifyConnection.findUnique({ where: { tenantId } });
      expect(row!.shopDomain).toBe(SECOND_SHOP);
    });

    it("keeps the cursors when the same store is re-authorised", async () => {
      await connectedWithCursors(FIRST_SHOP);
      const before = await cursors();

      const res = await callback(callbackRequest(FIRST_SHOP));
      expect(res.headers.get("location")).toContain("connected=1");

      expect(await cursors()).toEqual(before);
    });
  });
});
