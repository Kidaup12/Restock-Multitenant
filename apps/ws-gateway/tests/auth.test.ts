import { describe, expect, it, vi } from "vitest";
import { devAuthorizeSocket, sessionAuthorizeSocket, type SessionStore } from "../src/auth";

describe("devAuthorizeSocket", () => {
  const authorize = devAuthorizeSocket("devtoken");

  it("accepts {secret}:{tenantId} when the secret matches", async () => {
    await expect(authorize("devtoken:tenant-a")).resolves.toEqual({ tenantId: "tenant-a" });
  });

  it("takes everything after the first separator as the tenant id", async () => {
    await expect(authorize("devtoken:a:b")).resolves.toEqual({ tenantId: "a:b" });
  });

  it("rejects a wrong secret", async () => {
    await expect(authorize("wrong:tenant-a")).resolves.toBeNull();
  });

  it("rejects tokens without a separator or without a tenant", async () => {
    await expect(authorize("devtoken")).resolves.toBeNull();
    await expect(authorize("devtoken:")).resolves.toBeNull();
    await expect(authorize(":tenant-a")).resolves.toBeNull();
    await expect(authorize("")).resolves.toBeNull();
  });

  it("fails closed when no shared secret is configured", async () => {
    const disabled = devAuthorizeSocket(undefined);
    await expect(disabled("devtoken:tenant-a")).resolves.toBeNull();
    const empty = devAuthorizeSocket("");
    await expect(empty("devtoken:tenant-a")).resolves.toBeNull();
  });
});

describe("sessionAuthorizeSocket", () => {
  const future = new Date(Date.now() + 60_000);

  const store = (overrides?: Partial<SessionStore>): SessionStore => ({
    sessionByToken: async (token) =>
      token === "valid-token" ? { userId: "user-1", expiresAt: future } : null,
    membershipTenantIds: async (userId) => (userId === "user-1" ? ["tenant-a", "tenant-b"] : []),
    ...overrides,
  });

  it("resolves a raw session token to the first membership's tenant", async () => {
    await expect(sessionAuthorizeSocket(store())("valid-token")).resolves.toEqual({
      tenantId: "tenant-a",
    });
  });

  it("accepts a signed cookie value, stripping the signature part", async () => {
    const authorize = sessionAuthorizeSocket(store());
    await expect(authorize("valid-token.c2lnbmF0dXJl")).resolves.toEqual({ tenantId: "tenant-a" });
    // URL-encoded, as it appears in a raw Cookie header.
    await expect(authorize(encodeURIComponent("valid-token.c2ln+YQ=="))).resolves.toEqual({
      tenantId: "tenant-a",
    });
  });

  it("rejects unknown and empty tokens without a store roundtrip for empty", async () => {
    const sessionByToken = vi.fn(async () => null);
    const authorize = sessionAuthorizeSocket(store({ sessionByToken }));
    await expect(authorize("")).resolves.toBeNull();
    expect(sessionByToken).not.toHaveBeenCalled();
    await expect(authorize("unknown-token")).resolves.toBeNull();
    expect(sessionByToken).toHaveBeenCalledWith("unknown-token");
  });

  it("rejects an expired session", async () => {
    const expired = store({
      sessionByToken: async () => ({ userId: "user-1", expiresAt: new Date(Date.now() - 1000) }),
    });
    await expect(sessionAuthorizeSocket(expired)("valid-token")).resolves.toBeNull();
  });

  it("rejects a user with no memberships", async () => {
    const none = store({ membershipTenantIds: async () => [] });
    await expect(sessionAuthorizeSocket(none)("valid-token")).resolves.toBeNull();
  });

  it("routes tenant choice through the selector parameter", async () => {
    const second = sessionAuthorizeSocket(store(), (tenantIds) => tenantIds[1] ?? null);
    await expect(second("valid-token")).resolves.toEqual({ tenantId: "tenant-b" });
    const reject = sessionAuthorizeSocket(store(), () => null);
    await expect(reject("valid-token")).resolves.toBeNull();
  });
});
