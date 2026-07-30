import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Standing a customer's workspace up from the admin console, and the escalation
 * rules that come with it.
 *
 * Two things are being held here at once. One is the feature: an operator can
 * create a shop for someone who has not signed up, which previously needed
 * database access. The other is the boundary it opens — invites can now carry
 * OWNER, and that must remain reachable ONLY from the operator path. A workspace
 * able to mint its own owners or admins would be an escalation, not a feature.
 */

const dbUrl = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(dbUrl);

const ADMIN = { userId: "provision-admin", email: "provision@example.test", name: "Provision Admin" };

vi.mock("@/lib/admin/gate", () => ({ requireAdmin: async () => ADMIN }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
// The invite email rides the outbound seam; nothing here needs it to leave.
vi.mock("@/lib/email", () => ({ sendEmail: async () => {} }));

import { prismaService } from "@wezesha/db";
import { provisionWorkspaceAction } from "@/app/admin/actions";
import { invitableRoles, canChangeRole } from "@/lib/auth/team-guards";
import { getInvite } from "@/lib/auth/invites";

const EXISTING_EMAIL = "provision-existing-owner@example.test";
const NEW_EMAIL = "provision-new-owner@example.test";
const EXISTING_USER = "provision-existing-user";
const NAMES = ["Provisioned Shop A", "Provisioned Shop B"];

function form(name: string, ownerEmail: string): FormData {
  const body = new FormData();
  body.set("name", name);
  body.set("ownerEmail", ownerEmail);
  return body;
}

describe.skipIf(!runnable)("provisioning a workspace from the console (local db)", () => {
  beforeAll(async () => {
    await cleanup();
    await prismaService.user.create({
      data: { id: EXISTING_USER, name: "Existing Owner", email: EXISTING_EMAIL, emailVerified: true },
    });
  }, 60_000);

  afterAll(cleanup);

  async function cleanup() {
    const tenants = await prismaService.tenant.findMany({
      where: { name: { in: NAMES } },
      select: { id: true },
    });
    const ids = tenants.map((t) => t.id);
    if (ids.length) {
      await prismaService.auditEvent.deleteMany({ where: { tenantId: { in: ids } } });
      await prismaService.membership.deleteMany({ where: { tenantId: { in: ids } } });
      await prismaService.tenantConfig.deleteMany({ where: { tenantId: { in: ids } } });
      await prismaService.tenant.deleteMany({ where: { id: { in: ids } } });
    }
    await prismaService.user.deleteMany({ where: { email: EXISTING_EMAIL } });
  }

  it("hands the shop straight to an owner who already has an account", async () => {
    const result = await provisionWorkspaceAction(form(NAMES[0]!, EXISTING_EMAIL));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const members = await prismaService.membership.findMany({ where: { tenantId: result.tenantId } });
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ userId: EXISTING_USER, role: "OWNER" });

    // A workspace is only usable with its settings row, so provisioning writes
    // one exactly as self-serve signup does.
    const config = await prismaService.tenantConfig.findUnique({
      where: { tenantId: result.tenantId },
    });
    expect(config).not.toBeNull();

    const event = await prismaService.auditEvent.findFirst({
      where: { tenantId: result.tenantId, action: "workspace_provisioned" },
    });
    expect(event?.entity).toBe("Tenant");
    expect(event?.meta).toMatchObject({ ownerEmail: EXISTING_EMAIL, ownerStatus: "member" });
  });

  it("creates an unclaimed workspace and an OWNER invite when they have no account", async () => {
    const result = await provisionWorkspaceAction(form(NAMES[1]!, NEW_EMAIL));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // No members yet — which is what makes it unreachable rather than exposed.
    const members = await prismaService.membership.findMany({ where: { tenantId: result.tenantId } });
    expect(members).toHaveLength(0);

    const rows = await prismaService.verification.findMany({
      where: { identifier: `invite:${result.tenantId}:${NEW_EMAIL}` },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe("OWNER");

    const lookup = await getInvite(rows[0]!.id);
    expect(lookup.status).toBe("valid");
    if (lookup.status === "valid") expect(lookup.invite.role).toBe("OWNER");
  });

  it("refuses an invalid owner email before creating anything", async () => {
    const before = await prismaService.tenant.count();
    expect(await provisionWorkspaceAction(form("Should Not Exist", "not-an-email"))).toEqual({
      ok: false,
      error: "Enter a valid email address for the owner.",
    });
    expect(await prismaService.tenant.count()).toBe(before);
  });
});

describe("who may grant what inside a workspace", () => {
  const owner = { role: "OWNER" as const, permissions: null, membershipId: "m-owner" };
  const admin = { role: "ADMIN" as const, permissions: null, membershipId: "m-admin" };
  const staff = { role: "MEMBER" as const, permissions: null, membershipId: "m-staff" };

  it("lets nobody in a workspace invite an owner or an admin", () => {
    // The platform grants those; a shop grants staff. An owner who could mint
    // admins could hand out their own level of access.
    expect(invitableRoles(owner)).toEqual(["MEMBER"]);
    expect(invitableRoles(admin)).toEqual(["MEMBER"]);
  });

  it("lets staff invite nobody at all", () => {
    expect(invitableRoles(staff)).toEqual([]);
  });

  it("closes the promotion door as well as the invite door", () => {
    // Same grant, different route — closing one without the other just moves it.
    const target = { membershipId: "m-target", role: "MEMBER" as const };
    expect(canChangeRole(owner, target, "ADMIN", 1).ok).toBe(false);
    expect(canChangeRole(owner, target, "OWNER", 1).ok).toBe(false);
    expect(canChangeRole(admin, target, "ADMIN", 1).ok).toBe(false);
  });

  it("still lets an owner move an admin back down to staff", () => {
    // Demotion is not escalation, and an owner must be able to take access away.
    const adminTarget = { membershipId: "m-target", role: "ADMIN" as const };
    expect(canChangeRole(owner, adminTarget, "MEMBER", 1).ok).toBe(true);
    expect(canChangeRole(admin, adminTarget, "MEMBER", 1).ok).toBe(false);
  });

  it("never leaves a workspace without an owner", () => {
    const ownerTarget = { membershipId: "m-target", role: "OWNER" as const };
    expect(canChangeRole(owner, ownerTarget, "MEMBER", 1).ok).toBe(false);
    expect(canChangeRole(owner, ownerTarget, "MEMBER", 2).ok).toBe(true);
  });
});
