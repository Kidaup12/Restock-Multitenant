import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Connecting a store by pasting an Admin API access token.
 *
 * Why this path exists: the OAuth install uses OUR app's client id and secret,
 * one set for the whole platform, so a shop could not connect its own store at
 * all — which stalled testing outright. A shop's own custom app hands it a token
 * directly, and pasting it needs no round trip, no redirect registration and no
 * app review.
 *
 * What these hold: nothing is stored until the token has been proven against the
 * real store, an under-scoped token is refused with the missing scopes named, a
 * store already claimed elsewhere gets a sentence rather than a constraint
 * error, and a member cannot do any of it.
 */

const dbUrl = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(dbUrl);

const authState: { session: { user: { id: string } } | null; membership: unknown } = {
  session: { user: { id: "token-connect-user" } },
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

// The probe is the only thing that talks to Shopify. Stubbing it here keeps the
// test about what the ACTION does with each answer.
const probeState: { result: unknown; error: Error | null } = { result: null, error: null };
vi.mock("@wezesha/shopify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@wezesha/shopify")>();
  return {
    ...actual,
    createShopifyClient: () => ({ shopDomain: "stub", graphql: async () => ({}) }),
    probeConnection: async () => {
      if (probeState.error) throw probeState.error;
      return probeState.result;
    },
  };
});

import { prismaService } from "@wezesha/db";
import { decryptToken, ShopifyAuthError } from "@wezesha/shopify";
import { connectShopifyWithToken } from "@/app/(shell)/settings/connections/actions";

const SLUGS = ["token-connect-a", "token-connect-b"];
const GOOD_TOKEN = "shpat_abcdef0123456789";
const ALL_SCOPES = ["read_products", "read_inventory", "read_orders", "read_locations"];

describe.skipIf(!runnable)("connect a store with a pasted token (local db)", () => {
  let tenantA = "";
  let tenantB = "";

  const actAs = (tenantId: string, role: "OWNER" | "MEMBER" = "OWNER") => {
    authState.session = { user: { id: "token-connect-user" } };
    authState.membership = {
      id: `m-${tenantId}`,
      tenantId,
      role,
      permissions: null,
      tenant: { slug: "s", name: "s", currency: "KES" },
    };
  };

  beforeAll(async () => {
    process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 5).toString("base64");
    await cleanup();
    const [a, b] = await Promise.all(
      SLUGS.map((slug) => prismaService.tenant.create({ data: { name: slug, slug, plan: "growth" } }))
    );
    tenantA = a!.id;
    tenantB = b!.id;
  }, 60_000);

  beforeEach(async () => {
    probeState.error = null;
    probeState.result = {
      shopName: "Amara Beauty",
      currencyCode: "KES",
      grantedScopes: ALL_SCOPES,
      missingScopes: [],
    };
    await prismaService.shopifyConnection.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
    actAs(tenantA);
  });

  afterAll(cleanup);

  async function cleanup() {
    await prismaService.tenant.deleteMany({ where: { slug: { in: SLUGS } } });
  }

  it("stores the token encrypted, with the scopes the store actually granted", async () => {
    const res = await connectShopifyWithToken({
      shopDomain: "amara-demo.myshopify.com",
      accessToken: GOOD_TOKEN,
    });
    expect(res).toMatchObject({ ok: true });
    expect(res.ok && res.message).toContain("Amara Beauty");

    const row = await prismaService.shopifyConnection.findUnique({ where: { tenantId: tenantA } });
    expect(row!.authMode).toBe("token");
    // Never the plaintext: the column is ciphertext or this is a credential leak.
    expect(row!.accessToken).not.toBe(GOOD_TOKEN);
    expect(decryptToken(row!.accessToken)).toBe(GOOD_TOKEN);
    expect(row!.scopes).toBe(ALL_SCOPES.join(","));
  });

  it("writes nothing at all when Shopify refuses the token", async () => {
    probeState.error = new ShopifyAuthError(401, "amara-demo.myshopify.com");
    const res = await connectShopifyWithToken({
      shopDomain: "amara-demo.myshopify.com",
      accessToken: GOOD_TOKEN,
    });
    expect(res.ok).toBe(false);
    // A stored-but-unproven token is a connection the shop believes in and the
    // worker cannot use.
    expect(await prismaService.shopifyConnection.count({ where: { tenantId: tenantA } })).toBe(0);
  });

  it("names the missing scopes instead of connecting a token that cannot do the job", async () => {
    probeState.result = {
      shopName: "Partial",
      currencyCode: "KES",
      grantedScopes: ["read_products", "read_orders"],
      missingScopes: ["read_inventory", "read_locations"],
    };
    const res = await connectShopifyWithToken({
      shopDomain: "amara-demo.myshopify.com",
      accessToken: GOOD_TOKEN,
    });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toContain("read_inventory");
    expect(!res.ok && res.error).toContain("read_locations");
    expect(await prismaService.shopifyConnection.count({ where: { tenantId: tenantA } })).toBe(0);
  });

  it("explains a store that already belongs to another workspace", async () => {
    await connectShopifyWithToken({ shopDomain: "taken.myshopify.com", accessToken: GOOD_TOKEN });
    actAs(tenantB);
    const res = await connectShopifyWithToken({
      shopDomain: "taken.myshopify.com",
      accessToken: GOOD_TOKEN,
    });
    // The first thing anyone hits re-pasting after a failed attempt.
    expect(res).toMatchObject({ ok: false });
    expect(!res.ok && res.error).toContain("already connected");
  });

  it("refuses anything that is not a store address or not a token", async () => {
    const badShop = await connectShopifyWithToken({
      shopDomain: "https://evil.example.com",
      accessToken: GOOD_TOKEN,
    });
    expect(badShop.ok).toBe(false);
    const badToken = await connectShopifyWithToken({
      shopDomain: "amara-demo.myshopify.com",
      accessToken: "shpss_this_is_the_api_secret",
    });
    expect(badToken.ok).toBe(false);
    expect(!badToken.ok && badToken.error).toContain("shpat_");
  });

  it("is closed to a member", async () => {
    actAs(tenantA, "MEMBER");
    const res = await connectShopifyWithToken({
      shopDomain: "amara-demo.myshopify.com",
      accessToken: GOOD_TOKEN,
    });
    expect(res.ok).toBe(false);
    expect(await prismaService.shopifyConnection.count({ where: { tenantId: tenantA } })).toBe(0);
  });

  it("clears an earlier give-up state when a working token replaces a dead one", async () => {
    await connectShopifyWithToken({ shopDomain: "amara-demo.myshopify.com", accessToken: GOOD_TOKEN });
    await prismaService.shopifyConnection.update({
      where: { tenantId: tenantA },
      data: { authFailureCount: 3, syncPausedAt: new Date(), lastAuthError: "auth failed (403)" },
    });

    await connectShopifyWithToken({ shopDomain: "amara-demo.myshopify.com", accessToken: GOOD_TOKEN });

    const row = await prismaService.shopifyConnection.findUnique({ where: { tenantId: tenantA } });
    // Otherwise the scheduler keeps skipping a store that now works.
    expect(row!.syncPausedAt).toBeNull();
    expect(row!.authFailureCount).toBe(0);
  });
});
