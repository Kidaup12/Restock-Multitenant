import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The platform app, and the line it must not cross.
 *
 * A shop can register its own Shopify app, but most never will. The reference
 * build installs with ONE app the merchant approves — "Works on any store,
 * including non-Plus" — and that is the only route a live shop can use.
 *
 * An earlier rule here forbade any environment fallback, on the grounds that a
 * shared key "made it impossible for a client to connect its own store". That
 * was true of the flow it was written against: the CLIENT-CREDENTIALS grant,
 * which Shopify honours only when the app and the store share an organisation,
 * so a shared app can never reach a merchant's shop. It is not true of the
 * authorization-code install.
 *
 * So the fallback is deliberately one-sided, and these tests hold that line.
 */

const findUnique = vi.fn();
vi.mock("@wezesha/db", () => ({
  prismaForTenant: () => ({ shopifyAppCredential: { findUnique } }),
  prismaService: { shopifyAppCredential: { findUnique } },
}));
vi.mock("@wezesha/shopify", () => ({ decryptToken: (v: string) => `decrypted:${v}` }));

const KEY = process.env.SHOPIFY_API_KEY;
const SECRET = process.env.SHOPIFY_API_SECRET;

beforeEach(() => {
  findUnique.mockReset();
  delete process.env.SHOPIFY_API_KEY;
  delete process.env.SHOPIFY_API_SECRET;
});

afterEach(() => {
  if (KEY === undefined) delete process.env.SHOPIFY_API_KEY;
  else process.env.SHOPIFY_API_KEY = KEY;
  if (SECRET === undefined) delete process.env.SHOPIFY_API_SECRET;
  else process.env.SHOPIFY_API_SECRET = SECRET;
});

const load = () => import("@/lib/shopify/credentials");

describe("the platform Shopify app", () => {
  it("is absent until both halves are set", async () => {
    const { platformAppCredentials } = await load();
    expect(platformAppCredentials()).toBeNull();
    process.env.SHOPIFY_API_KEY = "platform-id";
    // A key with no secret cannot complete a token exchange; half-configured
    // must read as not configured, not as ready.
    expect(platformAppCredentials()).toBeNull();
    process.env.SHOPIFY_API_SECRET = "platform-secret";
    expect(platformAppCredentials()).toEqual({
      clientId: "platform-id",
      apiSecret: "platform-secret",
    });
  });

  it("installs with the platform app when the workspace has none", async () => {
    process.env.SHOPIFY_API_KEY = "platform-id";
    process.env.SHOPIFY_API_SECRET = "platform-secret";
    findUnique.mockResolvedValue(null);

    const { credentialsForInstall } = await load();
    expect(await credentialsForInstall("t1")).toEqual({
      clientId: "platform-id",
      apiSecret: "platform-secret",
    });
  });

  it("prefers the workspace's own app over the platform one", async () => {
    // A shop that registered its own app did so for a reason; installing under
    // ours instead would put its data behind a grant it never chose.
    process.env.SHOPIFY_API_KEY = "platform-id";
    process.env.SHOPIFY_API_SECRET = "platform-secret";
    findUnique.mockResolvedValue({ clientId: "their-id", apiSecret: "their-secret" });

    const { credentialsForInstall } = await load();
    expect(await credentialsForInstall("t1")).toEqual({
      clientId: "their-id",
      apiSecret: "decrypted:their-secret",
    });
  });

  it("still fails closed when neither exists", async () => {
    findUnique.mockResolvedValue(null);
    const { credentialsForInstall } = await load();
    expect(await credentialsForInstall("t1")).toBeNull();
  });

  it("NEVER lends the platform app to client-credentials minting", async () => {
    // The line. credentialsForTenant feeds token minting and webhook
    // verification. Minting against a shared app is precisely what cannot work
    // for a merchant's store, and falling back there would reintroduce the
    // failure the old no-fallback rule was guarding against.
    process.env.SHOPIFY_API_KEY = "platform-id";
    process.env.SHOPIFY_API_SECRET = "platform-secret";
    findUnique.mockResolvedValue(null);

    const { credentialsForTenant } = await load();
    expect(
      await credentialsForTenant("t1"),
      "the platform app leaked into client-credentials minting",
    ).toBeNull();
  });
});
