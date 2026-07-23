import { describe, expect, it } from "vitest";
import { devAuthorizeSocket } from "../src/auth";

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
