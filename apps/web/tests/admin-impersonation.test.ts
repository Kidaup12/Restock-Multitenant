import { describe, expect, it } from "vitest";
import {
  ADMIN_TENANT_TTL_MS,
  signAdminTenant,
  verifyAdminTenant,
} from "../lib/admin/impersonation";

/**
 * The signed workspace-grant cookie: round-trip, expiry, and every tamper
 * path must fail closed (null), never throw. Pure — sign/verify take the key
 * and clock explicitly.
 */

const KEY = "impersonation-test-secret";
const TENANT = "cmadmintest0000tenant";
const NOW = 1_750_000_000_000;

describe("admin workspace grant cookie", () => {
  it("round-trips the tenant id it signed", () => {
    const value = signAdminTenant(TENANT, NOW, KEY);
    expect(verifyAdminTenant(value, NOW, KEY)).toBe(TENANT);
  });

  it("stays valid up to (but not at) the 30-minute expiry", () => {
    const value = signAdminTenant(TENANT, NOW, KEY);
    expect(verifyAdminTenant(value, NOW + ADMIN_TENANT_TTL_MS - 1, KEY)).toBe(TENANT);
    expect(verifyAdminTenant(value, NOW + ADMIN_TENANT_TTL_MS, KEY)).toBeNull();
    expect(verifyAdminTenant(value, NOW + ADMIN_TENANT_TTL_MS + 1, KEY)).toBeNull();
  });

  it("rejects a payload swapped under the original signature", () => {
    const value = signAdminTenant(TENANT, NOW, KEY);
    const sig = value.slice(value.lastIndexOf(".") + 1);
    const forgedPayload = Buffer.from(
      JSON.stringify({ t: "some-other-tenant", exp: NOW + ADMIN_TENANT_TTL_MS })
    ).toString("base64url");
    expect(verifyAdminTenant(`${forgedPayload}.${sig}`, NOW, KEY)).toBeNull();
  });

  it("rejects a value signed with a different key", () => {
    const value = signAdminTenant(TENANT, NOW, "not-the-real-key");
    expect(verifyAdminTenant(value, NOW, KEY)).toBeNull();
  });

  it("rejects an extended expiry even when the tenant id is unchanged", () => {
    const value = signAdminTenant(TENANT, NOW, KEY);
    const sig = value.slice(value.lastIndexOf(".") + 1);
    const extended = Buffer.from(
      JSON.stringify({ t: TENANT, exp: NOW + 100 * ADMIN_TENANT_TTL_MS })
    ).toString("base64url");
    expect(verifyAdminTenant(`${extended}.${sig}`, NOW, KEY)).toBeNull();
  });

  it("rejects a flipped signature character", () => {
    const value = signAdminTenant(TENANT, NOW, KEY);
    // Flip the FIRST signature char (all 6 of its bits count; the final char's
    // low bits are base64 padding and could decode identically).
    const dot = value.lastIndexOf(".");
    const first = value[dot + 1]!;
    const flipped =
      value.slice(0, dot + 1) + (first === "A" ? "B" : "A") + value.slice(dot + 2);
    expect(verifyAdminTenant(flipped, NOW, KEY)).toBeNull();
  });

  it("rejects garbage, empty, and structurally wrong values", () => {
    for (const junk of [
      null,
      undefined,
      "",
      "no-dot-here",
      ".leading-dot",
      "a.b.c".repeat(50),
      `${Buffer.from("not json").toString("base64url")}.deadbeef`,
      `${Buffer.from(JSON.stringify({ t: 42, exp: "soon" })).toString("base64url")}.deadbeef`,
    ]) {
      expect(verifyAdminTenant(junk, NOW, KEY)).toBeNull();
    }
  });
});
