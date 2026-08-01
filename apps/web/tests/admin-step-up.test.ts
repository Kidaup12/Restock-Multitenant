import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ADMIN_STEPUP_TTL_MS, signStepUp, verifyStepUp } from "../lib/admin/step-up";

/**
 * The signed step-up cookie: round-trip, expiry, and every tamper path must
 * fail closed (null), never throw. Pure — sign/verify take the key and clock
 * explicitly.
 *
 * The grant names a user rather than a permission, so that a cookie left in a
 * browser is worthless to whoever signs in next; the caller compares the
 * returned id against the live session.
 */

const KEY = "step-up-test-secret";
const USER = "cmadmintest0000user";
const OTHER = "cmadmintest0000other";
const NOW = 1_750_000_000_000;

describe("admin step-up cookie", () => {
  it("round-trips the user id it signed", () => {
    expect(verifyStepUp(signStepUp(USER, NOW, KEY), NOW, KEY)).toBe(USER);
  });

  it("names the user it was minted for, and no other", () => {
    const value = signStepUp(USER, NOW, KEY);
    expect(verifyStepUp(value, NOW, KEY)).not.toBe(OTHER);
  });

  it("stays valid up to (but not at) the 30-minute expiry", () => {
    const value = signStepUp(USER, NOW, KEY);
    expect(verifyStepUp(value, NOW + ADMIN_STEPUP_TTL_MS - 1, KEY)).toBe(USER);
    expect(verifyStepUp(value, NOW + ADMIN_STEPUP_TTL_MS, KEY)).toBeNull();
    expect(verifyStepUp(value, NOW + ADMIN_STEPUP_TTL_MS + 1, KEY)).toBeNull();
  });

  it("rejects a payload swapped under the original signature", () => {
    const value = signStepUp(USER, NOW, KEY);
    const sig = value.slice(value.lastIndexOf(".") + 1);
    const forged = Buffer.from(
      JSON.stringify({ u: OTHER, exp: NOW + ADMIN_STEPUP_TTL_MS })
    ).toString("base64url");
    expect(verifyStepUp(`${forged}.${sig}`, NOW, KEY)).toBeNull();
  });

  it("rejects a value signed with a different key", () => {
    expect(verifyStepUp(signStepUp(USER, NOW, "not-the-real-key"), NOW, KEY)).toBeNull();
  });

  it("rejects an extended expiry even when the user id is unchanged", () => {
    const value = signStepUp(USER, NOW, KEY);
    const sig = value.slice(value.lastIndexOf(".") + 1);
    const extended = Buffer.from(
      JSON.stringify({ u: USER, exp: NOW + 100 * ADMIN_STEPUP_TTL_MS })
    ).toString("base64url");
    expect(verifyStepUp(`${extended}.${sig}`, NOW, KEY)).toBeNull();
  });

  it("rejects a flipped signature character", () => {
    const value = signStepUp(USER, NOW, KEY);
    // Flip the FIRST signature char: all 6 of its bits count, where the final
    // char's low bits are base64 padding and could decode identically.
    const dot = value.lastIndexOf(".");
    const first = value[dot + 1]!;
    const flipped = value.slice(0, dot + 1) + (first === "A" ? "B" : "A") + value.slice(dot + 2);
    expect(verifyStepUp(flipped, NOW, KEY)).toBeNull();
  });

  it("rejects a workspace grant presented as a step-up grant", () => {
    // The two cookies are signed with the same secret and the same construction.
    // What separates them is the payload shape, so that has to be what is
    // checked — not merely the signature.
    const workspaceGrant = Buffer.from(
      JSON.stringify({ t: "some-tenant", exp: NOW + ADMIN_STEPUP_TTL_MS })
    ).toString("base64url");
    const sig = createHmac("sha256", KEY).update(workspaceGrant).digest("base64url");
    expect(verifyStepUp(`${workspaceGrant}.${sig}`, NOW, KEY)).toBeNull();
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
      `${Buffer.from(JSON.stringify({ u: 42, exp: "soon" })).toString("base64url")}.deadbeef`,
    ]) {
      expect(verifyStepUp(junk, NOW, KEY)).toBeNull();
    }
  });
});
