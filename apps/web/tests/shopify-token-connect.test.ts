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
/** What the action actually presented to Shopify, and what the mint was asked
 *  for — the two things "test the credential the sync uses" is about. */
const seen: { probedWith: string | null; mintedFor: unknown } = {
  probedWith: null,
  mintedFor: null,
};
const mintState: { token: string; error: Error | null } = { token: "", error: null };
vi.mock("@wezesha/shopify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@wezesha/shopify")>();
  return {
    ...actual,
    createShopifyClient: (opts: { shopDomain: string; accessToken: string }) => {
      seen.probedWith = opts.accessToken;
      return { shopDomain: opts.shopDomain, graphql: async () => ({}) };
    },
    mintAdminToken: async (shopDomain: string, credentials: unknown) => {
      seen.mintedFor = { shopDomain, credentials };
      if (mintState.error) throw mintState.error;
      return { accessToken: mintState.token, scopes: [], expiresAt: Date.now() + 3_600_000 };
    },
    probeConnection: async () => {
      if (probeState.error) throw probeState.error;
      return probeState.result;
    },
  };
});

import { prismaService } from "@wezesha/db";
import {
  decryptToken,
  ShopifyAuthError,
  ShopifyGrantError,
  ShopifyRateLimitedError,
} from "@wezesha/shopify";
import {
  clearShopifyAppCredentials,
  connectShopifyWithToken,
  saveShopifyAppCredentials,
  testShopifyConnection,
} from "@/app/(shell)/settings/connections/actions";
import { credentialsForShopDomain, credentialsForTenant } from "@/lib/shopify/credentials";

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

  describe("test connection", () => {
    beforeEach(async () => {
      await connectShopifyWithToken({
        shopDomain: "amara-demo.myshopify.com",
        accessToken: GOOD_TOKEN,
      });
      // Testing the connection is throttled per workspace, counted from the
      // audit trail. These cases press it far more often than a person would,
      // so each starts from a clean count — they are about what the probe uses,
      // not about the throttle, which has its own test.
      await prismaService.auditEvent.deleteMany({
        where: { action: "shopify_connection_tested" },
      });
    });

    it("stops a person hammering it, and says why", async () => {
      // Each press mints a token against the shop's OAuth endpoint, and Shopify
      // rate limits that — the throttling lands on the MERCHANT, not on us. The
      // press count is exactly what rises when someone is staring at a red
      // error, which is when it matters.
      const results = [];
      for (let i = 0; i < 7; i++) results.push(await testShopifyConnection());

      const refused = results.filter((r) => !r.ok);
      expect(refused.length, "nothing stopped seven presses in a row").toBeGreaterThan(0);
      expect((refused[0] as { error: string }).error).toContain("as often as Shopify will let us");
    });

    it("names the store and its currency when everything works", async () => {
      const res = await testShopifyConnection();
      expect(res).toMatchObject({ ok: true });
      expect(res.ok && res.message).toContain("Amara Beauty");
      expect(res.ok && res.message).toContain("KES");
    });

    it("says the token was rejected, and by which store", async () => {
      probeState.error = new ShopifyAuthError(403, "amara-demo.myshopify.com");
      const res = await testShopifyConnection();
      expect(res.ok).toBe(false);
      // Naming the store matters: the usual cause is a token from a different one.
      expect(!res.ok && res.error).toContain("amara-demo.myshopify.com");
    });

    it("distinguishes rate limiting from a dead token", async () => {
      probeState.error = new ShopifyRateLimitedError(2000, "throttled");
      const res = await testShopifyConnection();
      expect(res.ok).toBe(false);
      // "Try again" and "reconnect the store" are very different instructions.
      expect(!res.ok && res.error).toContain("rate limiting");
    });

    it("reports a connection that works but cannot see everything", async () => {
      probeState.result = {
        shopName: "Amara Beauty",
        currencyCode: "KES",
        grantedScopes: ["read_products", "read_orders"],
        missingScopes: ["read_inventory"],
      };
      const res = await testShopifyConnection();
      expect(res.ok).toBe(false);
      expect(!res.ok && res.error).toContain("read_inventory");
    });

    it("changes nothing — it is a read", async () => {
      const before = await prismaService.shopifyConnection.findUnique({ where: { tenantId: tenantA } });
      probeState.error = new ShopifyAuthError(403, "amara-demo.myshopify.com");
      await testShopifyConnection();
      const after = await prismaService.shopifyConnection.findUnique({ where: { tenantId: tenantA } });
      // A failed test must not count towards the auto-pause: someone checking
      // whether a store is healthy should not be able to switch its syncs off.
      expect(after!.authFailureCount).toBe(before!.authFailureCount);
      expect(after!.syncPausedAt).toEqual(before!.syncPausedAt);
    });

    it("is closed to a member", async () => {
      actAs(tenantA, "MEMBER");
      const res = await testShopifyConnection();
      expect(res.ok).toBe(false);
    });

    it("probes with the pasted token when that is what the sync would use", async () => {
      seen.probedWith = null;
      await testShopifyConnection();
      expect(seen.probedWith).toBe(GOOD_TOKEN);
    });

    /**
     * The defect this replaced, seen on a live workspace: the action decrypted
     * `connection.accessToken` and probed with it. Where app credentials exist
     * the worker never presents that token — it mints a fresh one every run —
     * and a client-credentials token dies in about a day. So the button reported
     * "the store rejected our access token" over a store syncing perfectly, and
     * sent whoever pressed it to reconnect a connection that was fine.
     */
    describe("on a workspace connected by app credentials", () => {
      beforeEach(async () => {
        await saveShopifyAppCredentials({ clientId: "client-id", apiSecret: "client-secret" });
        mintState.error = null;
        mintState.token = "shpat_freshly_minted";
        seen.probedWith = null;
        seen.mintedFor = null;
      });

      it("probes with the stored token, which is what the sync now uses", async () => {
        // The invariant here has always been "test what the sync would use" —
        // that has not changed, the sync has. It used to mint on every run, so
        // this asserted minting. It now prefers the stored token, because every
        // token we store is long-lived and preferring credentials made the
        // install route unusable for a live shop: saving credentials is a
        // precondition of installing, and having them saved was what threw the
        // resulting token away.
        const res = await testShopifyConnection();
        expect(res).toMatchObject({ ok: true });
        expect(seen.probedWith).toBe(GOOD_TOKEN);
        expect(seen.mintedFor, "minted despite holding a working token").toBeNull();
      });

      it("blames the credentials, not the store, when the grant is refused", async () => {
        // Minting is the fallback now, so reaching it means there is no stored
        // token to prefer. Kept rather than deleted: the branch still exists,
        // and this is the message it must give.
        await prismaService.shopifyConnection.updateMany({
          where: { tenantId: tenantA },
          data: { accessToken: "" },
        });
        mintState.error = new ShopifyGrantError(401, "amara-demo.myshopify.com", "bad client");
        const res = await testShopifyConnection();
        expect(res.ok).toBe(false);
        expect(!res.ok && res.error).toContain("app credentials");
        // Telling someone to reconnect a healthy store is the wrong remedy.
        expect(!res.ok && res.error).not.toContain("Reconnect the store");
      });

      it("still changes nothing", async () => {
        const before = await prismaService.shopifyConnection.findUnique({
          where: { tenantId: tenantA },
        });
        mintState.error = new ShopifyGrantError(401, "amara-demo.myshopify.com", "bad client");
        await testShopifyConnection();
        const after = await prismaService.shopifyConnection.findUnique({
          where: { tenantId: tenantA },
        });
        expect(after!.accessToken).toBe(before!.accessToken);
        expect(after!.syncPausedAt).toEqual(before!.syncPausedAt);
      });
    });
  });

  describe("per-workspace app credentials", () => {
    const CLIENT_ID = "abc123clientid";
    const API_SECRET = "shpss_secret_value_xyz";

    beforeEach(async () => {
      await prismaService.shopifyAppCredential.deleteMany({
        where: { tenantId: { in: [tenantA, tenantB] } },
      });
      actAs(tenantA);
    });

    it("stores the secret encrypted and reads it back for that workspace only", async () => {
      const res = await saveShopifyAppCredentials({ clientId: CLIENT_ID, apiSecret: API_SECRET });
      expect(res).toMatchObject({ ok: true });

      const row = await prismaService.shopifyAppCredential.findUnique({ where: { tenantId: tenantA } });
      // The client id is not a secret — it travels in the authorize URL.
      expect(row!.clientId).toBe(CLIENT_ID);
      // The secret is. Plaintext in this column would be the leak.
      expect(row!.apiSecret).not.toBe(API_SECRET);
      await expect(credentialsForTenant(tenantA)).resolves.toEqual({
        clientId: CLIENT_ID,
        apiSecret: API_SECRET,
      });
      // Another workspace has its own, or none. Never this one's.
      await expect(credentialsForTenant(tenantB)).resolves.toBeNull();
    });

    it("has no environment fallback — an unconfigured workspace gets nothing", async () => {
      // The whole point: one shared app across every client is what stopped a
      // client connecting its own store. A fallback would reintroduce it.
      process.env.SHOPIFY_API_KEY = "leftover-platform-key";
      process.env.SHOPIFY_API_SECRET = "leftover-platform-secret";
      try {
        await expect(credentialsForTenant(tenantA)).resolves.toBeNull();
      } finally {
        delete process.env.SHOPIFY_API_KEY;
        delete process.env.SHOPIFY_API_SECRET;
      }
    });

    it("resolves a webhook's shop domain to that workspace's secret", async () => {
      await saveShopifyAppCredentials({ clientId: CLIENT_ID, apiSecret: API_SECRET });
      await connectShopifyWithToken({
        shopDomain: "creds-demo.myshopify.com",
        accessToken: GOOD_TOKEN,
      });

      const resolved = await credentialsForShopDomain("creds-demo.myshopify.com");
      expect(resolved).toMatchObject({ tenantId: tenantA, apiSecret: API_SECRET });
      // A domain nobody has connected must not resolve to anyone's secret.
      await expect(credentialsForShopDomain("nobody.myshopify.com")).resolves.toBeNull();
    });

    it("removing them leaves a connected store alone", async () => {
      await saveShopifyAppCredentials({ clientId: CLIENT_ID, apiSecret: API_SECRET });
      await connectShopifyWithToken({
        shopDomain: "creds-demo.myshopify.com",
        accessToken: GOOD_TOKEN,
      });

      await clearShopifyAppCredentials();

      await expect(credentialsForTenant(tenantA)).resolves.toBeNull();
      // The store keeps syncing on its stored access token; only new installs
      // and webhook verification depend on the app credentials.
      expect(await prismaService.shopifyConnection.count({ where: { tenantId: tenantA } })).toBe(1);
    });

    it("never returns the secret to the settings screen", async () => {
      await saveShopifyAppCredentials({ clientId: CLIENT_ID, apiSecret: API_SECRET });
      // The page selects only the client id — the shape the card is handed.
      const shown = await prismaService.shopifyAppCredential.findUnique({
        where: { tenantId: tenantA },
        select: { clientId: true },
      });
      expect(Object.keys(shown!)).toEqual(["clientId"]);
    });

    it("keeps the stored secret when only the client id changes", async () => {
      // The secret is never shown again, so a blank box can only mean "leave it
      // alone". Requiring it on every edit is what made a Save press appear to
      // do nothing and left a workspace believing it was configured.
      await saveShopifyAppCredentials({ clientId: CLIENT_ID, apiSecret: API_SECRET });
      const res = await saveShopifyAppCredentials({ clientId: "newclientid999", apiSecret: "" });
      expect(res).toMatchObject({ ok: true });

      await expect(credentialsForTenant(tenantA)).resolves.toEqual({
        clientId: "newclientid999",
        apiSecret: API_SECRET,
      });
    });

    it("refuses a blank secret when there is no stored one to keep", async () => {
      const res = await saveShopifyAppCredentials({ clientId: CLIENT_ID, apiSecret: "" });
      expect(res.ok).toBe(false);
      // Says so, rather than a disabled button silently doing nothing.
      expect(!res.ok && res.error).toContain("API secret");
      expect(await prismaService.shopifyAppCredential.count({ where: { tenantId: tenantA } })).toBe(0);
    });

    it("is closed to a member", async () => {
      actAs(tenantA, "MEMBER");
      const res = await saveShopifyAppCredentials({ clientId: CLIENT_ID, apiSecret: API_SECRET });
      expect(res.ok).toBe(false);
      expect(await prismaService.shopifyAppCredential.count({ where: { tenantId: tenantA } })).toBe(0);
    });
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
