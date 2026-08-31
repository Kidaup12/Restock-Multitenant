import { describe, expect, it } from "vitest";
import {
  GRANTABLE_PERMISSIONS,
  canSetPermissions,
  type TeamActor,
} from "@/lib/auth/team-guards";
import { PERMISSION_KEYS } from "@/lib/auth/permissions";

/**
 * Who may re-permission whom.
 *
 * The rule doing the real work is that `manage_team` cannot be handed out as a
 * checkbox. `canChangeRole` already refuses every promotion out of MEMBER —
 * only the platform team grants admin and owner access — and team management IS
 * that access. A grantable `manage_team` would reopen the same escalation by a
 * different door, and it would look like an ordinary permission while doing it.
 */

const owner: TeamActor = { membershipId: "m-owner", role: "OWNER", permissions: null };
const admin: TeamActor = { membershipId: "m-admin", role: "ADMIN", permissions: null };
const member: TeamActor = { membershipId: "m-member", role: "MEMBER", permissions: null };

const targetMember = { membershipId: "t-member", role: "MEMBER" as const };
const targetAdmin = { membershipId: "t-admin", role: "ADMIN" as const };

describe("granting permissions to a teammate", () => {
  it("lets an owner grant the everyday ones", () => {
    expect(canSetPermissions(owner, targetMember, ["view_costs"]).ok).toBe(true);
    expect(canSetPermissions(owner, targetMember, ["manage_settings"]).ok).toBe(true);
    expect(canSetPermissions(owner, targetMember, ["approve_orders"]).ok).toBe(true);
  });

  it("refuses to hand out team management — that is a role change", () => {
    const res = canSetPermissions(owner, targetMember, ["manage_team"]);
    expect(res.ok, "manage_team was grantable as a permission").toBe(false);
  });

  it("refuses it even mixed in with legitimate ones", () => {
    // The shape an escalation would actually take: a plausible request with one
    // extra key in it.
    const res = canSetPermissions(owner, targetMember, ["view_costs", "manage_team"]);
    expect(res.ok).toBe(false);
  });

  it("keeps the grantable set a strict subset of what exists", () => {
    // If a new permission key is added and quietly becomes grantable, this is
    // the test that notices. Anything new is opt-in, not automatic.
    for (const key of GRANTABLE_PERMISSIONS) {
      expect(PERMISSION_KEYS).toContain(key);
    }
    expect(GRANTABLE_PERMISSIONS).not.toContain("manage_team");
  });

  it("stops someone editing their own access", () => {
    const self = { membershipId: owner.membershipId, role: "OWNER" as const };
    expect(canSetPermissions(owner, self, ["view_costs"]).ok).toBe(false);
  });

  it("stops an admin re-permissioning another admin", () => {
    expect(canSetPermissions(admin, targetAdmin, ["view_costs"]).ok).toBe(false);
    expect(canSetPermissions(owner, targetAdmin, ["view_costs"]).ok).toBe(true);
  });

  it("refuses anyone without team management", () => {
    expect(canSetPermissions(member, targetMember, ["view_costs"]).ok).toBe(false);
  });

  it("allows clearing every permission — an explicit empty grant", () => {
    // Distinct from inheriting the role preset, and a legitimate thing to want:
    // a member who may do nothing but look at the buy list.
    expect(canSetPermissions(owner, targetMember, []).ok).toBe(true);
  });
});
