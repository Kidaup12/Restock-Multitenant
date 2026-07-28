import { describe, expect, it } from "vitest";
import {
  hasPermission,
  PERMISSION_KEYS,
  type PermissionKey,
  resolvePermissions,
} from "../lib/auth/permissions";

describe("role presets", () => {
  it("gives OWNER and ADMIN every permission", () => {
    for (const role of ["OWNER", "ADMIN"] as const) {
      const resolved = resolvePermissions({ role, permissions: null });
      expect([...resolved].sort()).toEqual([...PERMISSION_KEYS].sort());
    }
  });

  it("leaves MEMBER with orders only — money-blind, no team, no settings", () => {
    const membership = { role: "MEMBER" as const, permissions: null };
    expect(hasPermission(membership, "view_costs")).toBe(false);
    expect(hasPermission(membership, "manage_team")).toBe(false);
    expect(hasPermission(membership, "manage_settings")).toBe(false);
    expect(hasPermission(membership, "approve_orders")).toBe(true);
  });
});

describe("member escalation", () => {
  /**
   * The gates the shop-floor role must not clear, each named for the server-side
   * check that enforces it. Every one of these re-checks the listed keys itself,
   * so a MEMBER failing them here is a MEMBER refused there.
   */
  const ADMIN_ONLY: [string, readonly PermissionKey[]][] = [
    ["supplier create/update/delete", ["manage_settings"]],
    ["product archive / not-for-sale", ["manage_settings"]],
    ["product category assign/rename/delete", ["manage_settings"]],
    ["workspace settings save", ["manage_settings"]],
    ["location role", ["manage_settings"]],
    ["promo and closure declaration", ["manage_settings"]],
    ["forecast priors", ["manage_settings"]],
    ["cost pin / price edit / cost import", ["view_costs", "manage_settings"]],
  ];

  it("refuses a MEMBER every workspace-administration gate", () => {
    const membership = { role: "MEMBER" as const, permissions: null };
    for (const [surface, needed] of ADMIN_ONLY) {
      expect(needed.every((key) => hasPermission(membership, key)), surface).toBe(false);
    }
  });

  it("still lets a MEMBER work orders", () => {
    const membership = { role: "MEMBER" as const, permissions: null };
    expect(hasPermission(membership, "approve_orders")).toBe(true);
  });

  it("grants settings to a MEMBER only through an explicit override", () => {
    const granted = { role: "MEMBER" as const, permissions: ["manage_settings"] };
    expect(hasPermission(granted, "manage_settings")).toBe(true);
    expect(hasPermission(granted, "view_costs")).toBe(false);
  });
});

describe("permission overrides", () => {
  it("uses the stored array instead of the preset when non-null", () => {
    const membership = { role: "MEMBER" as const, permissions: ["view_costs"] };
    expect(hasPermission(membership, "view_costs")).toBe(true);
    expect(hasPermission(membership, "manage_settings")).toBe(false);
    expect(hasPermission(membership, "approve_orders")).toBe(false);
  });

  it("treats an empty array as an explicit no-permissions override", () => {
    const membership = { role: "OWNER" as const, permissions: [] };
    for (const key of PERMISSION_KEYS) {
      expect(hasPermission(membership, key)).toBe(false);
    }
  });

  it("ignores unknown values in a stored array", () => {
    const membership = {
      role: "MEMBER" as const,
      permissions: ["view_costs", "retired_key", 42, null],
    };
    expect([...resolvePermissions(membership)]).toEqual(["view_costs"]);
  });

  it("falls back to the preset for malformed (non-array) json", () => {
    for (const stored of [{ view_costs: true }, "view_costs", 1]) {
      const membership = { role: "MEMBER" as const, permissions: stored };
      expect(hasPermission(membership, "approve_orders")).toBe(true);
      expect(hasPermission(membership, "manage_settings")).toBe(false);
      expect(hasPermission(membership, "view_costs")).toBe(false);
    }
  });
});
