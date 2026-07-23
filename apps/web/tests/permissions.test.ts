import { describe, expect, it } from "vitest";
import {
  hasPermission,
  PERMISSION_KEYS,
  resolvePermissions,
} from "../lib/auth/permissions";

describe("role presets", () => {
  it("gives OWNER and ADMIN every permission", () => {
    for (const role of ["OWNER", "ADMIN"] as const) {
      const resolved = resolvePermissions({ role, permissions: null });
      expect([...resolved].sort()).toEqual([...PERMISSION_KEYS].sort());
    }
  });

  it("keeps MEMBER money-blind and out of team management", () => {
    const membership = { role: "MEMBER" as const, permissions: null };
    expect(hasPermission(membership, "view_costs")).toBe(false);
    expect(hasPermission(membership, "manage_team")).toBe(false);
    expect(hasPermission(membership, "manage_settings")).toBe(true);
    expect(hasPermission(membership, "approve_orders")).toBe(true);
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
      expect(hasPermission(membership, "manage_settings")).toBe(true);
      expect(hasPermission(membership, "view_costs")).toBe(false);
    }
  });
});
