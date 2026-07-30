import { describe, expect, it } from "vitest";
import type { Role } from "@wezesha/db";
import {
  canChangeRole,
  canRemoveMember,
  invitableRoles,
  type TeamActor,
  type TeamTarget,
} from "../lib/auth/team-guards";

const actor = (
  role: Role,
  overrides: Partial<TeamActor> = {},
): TeamActor => ({
  membershipId: `actor-${role.toLowerCase()}`,
  role,
  permissions: null,
  ...overrides,
});

const target = (role: Role, membershipId = `target-${role.toLowerCase()}`): TeamTarget => ({
  membershipId,
  role,
});

describe("invitableRoles", () => {
  it("limits even an OWNER to inviting staff", () => {
    // A shop invites its staff. Who else may own or co-manage that shop is a
    // platform decision, made by an operator — an owner who could mint admins
    // could hand out their own level of access.
    expect(invitableRoles(actor("OWNER"))).toEqual(["MEMBER"]);
  });

  it("limits an ADMIN to inviting members", () => {
    expect(invitableRoles(actor("ADMIN"))).toEqual(["MEMBER"]);
  });

  it("gives a MEMBER (no manage_team) nothing", () => {
    expect(invitableRoles(actor("MEMBER"))).toEqual([]);
  });

  it("respects a manage_team override, still on the MEMBER ladder", () => {
    expect(
      invitableRoles(actor("MEMBER", { permissions: ["manage_team"] })),
    ).toEqual(["MEMBER"]);
  });
});

describe("canChangeRole", () => {
  it("requires manage_team", () => {
    expect(
      canChangeRole(actor("MEMBER"), target("MEMBER"), "ADMIN", 2).ok,
    ).toBe(false);
  });

  it("blocks changing your own role", () => {
    const self = actor("OWNER");
    const result = canChangeRole(
      self,
      { membershipId: self.membershipId, role: "OWNER" },
      "ADMIN",
      2,
    );
    expect(result.ok).toBe(false);
  });

  it("lets an OWNER move an admin down, but nobody up", () => {
    // Promotion is the same grant as an invite, by another door: an owner may
    // take access away, never hand out their own level of it.
    expect(canChangeRole(actor("OWNER"), target("ADMIN"), "MEMBER", 2).ok).toBe(true);
    expect(canChangeRole(actor("OWNER"), target("MEMBER"), "ADMIN", 2).ok).toBe(false);
    expect(canChangeRole(actor("OWNER"), target("MEMBER"), "OWNER", 1).ok).toBe(false);
  });

  it("keeps ADMIN targets and the ADMIN/OWNER grants owner-only", () => {
    expect(canChangeRole(actor("ADMIN"), target("ADMIN"), "MEMBER", 2).ok).toBe(false);
    expect(canChangeRole(actor("ADMIN"), target("MEMBER"), "ADMIN", 2).ok).toBe(false);
    expect(canChangeRole(actor("ADMIN"), target("OWNER"), "MEMBER", 2).ok).toBe(false);
  });

  it("never demotes the last OWNER", () => {
    // Demotion goes to staff now that ADMIN is not grantable, but the rule it
    // is guarding is unchanged: a workspace always keeps one owner.
    expect(canChangeRole(actor("OWNER"), target("OWNER"), "MEMBER", 1).ok).toBe(false);
    expect(canChangeRole(actor("OWNER"), target("OWNER"), "MEMBER", 2).ok).toBe(true);
  });
});

describe("canRemoveMember", () => {
  it("requires manage_team", () => {
    expect(canRemoveMember(actor("MEMBER"), target("MEMBER"), 2).ok).toBe(false);
  });

  it("lets ADMIN remove members but not admins or owners", () => {
    expect(canRemoveMember(actor("ADMIN"), target("MEMBER"), 2).ok).toBe(true);
    expect(canRemoveMember(actor("ADMIN"), target("ADMIN"), 2).ok).toBe(false);
    expect(canRemoveMember(actor("ADMIN"), target("OWNER"), 2).ok).toBe(false);
  });

  it("lets OWNER remove admins, and co-owners while another owner remains", () => {
    expect(canRemoveMember(actor("OWNER"), target("ADMIN"), 2).ok).toBe(true);
    expect(canRemoveMember(actor("OWNER"), target("OWNER"), 2).ok).toBe(true);
    expect(canRemoveMember(actor("OWNER"), target("OWNER"), 1).ok).toBe(false);
  });

  it("lets a manage_team override remove members from the MEMBER ladder", () => {
    const empowered = actor("MEMBER", { permissions: ["manage_team"] });
    expect(canRemoveMember(empowered, target("MEMBER"), 2).ok).toBe(true);
    expect(canRemoveMember(empowered, target("ADMIN"), 2).ok).toBe(false);
  });
});
