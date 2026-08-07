import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Granting ownership of an existing workspace, from the admin console.
 *
 * Every other owner grant in the product is bound to workspace creation, so a
 * workspace that changed hands — or a client wanting a colleague in — had no
 * answer short of a hand-written INSERT. The in-workspace team screen cannot
 * provide it: `invitableRoles` caps every actor there at MEMBER so an owner
 * cannot hand out their own access, and that guard is deliberately untouched.
 *
 * The gate and the step-up grant each have their own suite; they are held open
 * here so the action itself is the only thing being measured.
 */

const dbUrl = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(dbUrl);

const ADMIN = {
  userId: "admin-invite-user",
  email: "invite-admin@example.test",
  name: "Invite Admin",
  viaFallback: false,
};

const sent: { to: string; text: string }[] = [];

vi.mock("@/lib/admin/gate", () => ({ requireAdmin: async () => ADMIN }));
vi.mock("@/lib/admin/step-up", () => ({ hasStepUp: async () => true }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/email", () => ({
  sendEmail: async (input: { to: string; text: string }) => {
    if (input.to.includes("bounce")) throw new Error("delivery failed");
    sent.push(input);
  },
}));

import { prismaAuth, prismaService, Role } from "@wezesha/db";
import { inviteWorkspaceOwner } from "@/app/admin/actions";

const SLUG = "admin-invite-owner-tenant";

function form(tenantId: string, email: string): FormData {
  const body = new FormData();
  body.set("tenantId", tenantId);
  body.set("email", email);
  return body;
}

describe.skipIf(!runnable)("inviting an owner to an existing workspace", () => {
  let tenantId: string;

  const pendingFor = async (email: string) =>
    prismaAuth.verification.findFirst({
      where: { identifier: { contains: tenantId }, value: { contains: "OWNER" } },
    }).then((row) => (row && row.identifier.includes(email.toLowerCase()) ? row : null));

  beforeAll(async () => {
    process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    tenantId = (await prismaService.tenant.create({
      data: { name: "Invite Owner Co", slug: SLUG, plan: "growth" },
    })).id;
  });

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { id: tenantId } });
    await prismaService.$disconnect();
  });

  it("sends an OWNER invite and emails the link", async () => {
    sent.length = 0;
    const result = await inviteWorkspaceOwner(form(tenantId, "Second.Owner@Example.test"));
    expect(result).toMatchObject({ ok: true });

    // Normalised on the way in, so the invite cannot be duplicated by casing.
    expect(result).toMatchObject({ email: "second.owner@example.test" });
    expect(await pendingFor("second.owner@example.test")).not.toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("as its owner");
  });

  it("writes the grant to the admin ledger", async () => {
    const event = await prismaService.auditEvent.findFirst({
      where: { tenantId, action: "owner_invited" },
      orderBy: { createdAt: "desc" },
    });
    expect(event).not.toBeNull();
    expect(event!.meta as Record<string, unknown>).toMatchObject({
      email: "second.owner@example.test",
    });
    expect(event!.actorUserId).toBe(ADMIN.userId);
  });

  it("takes the invite back when the email cannot be delivered", async () => {
    // Same rule the workspace's own invite form follows: a row written without
    // its email is a link nobody holds, and it reads as "they were invited".
    const result = await inviteWorkspaceOwner(form(tenantId, "bounce@example.test"));
    expect(result.ok).toBe(false);
    expect(await pendingFor("bounce@example.test")).toBeNull();
  });

  it("refuses someone who is already in the workspace", async () => {
    const user = await prismaService.user.upsert({
      where: { email: "already@example.test" },
      update: {},
      create: { id: "admin-invite-existing", name: "Already In", email: "already@example.test" },
    });
    await prismaService.membership.create({
      data: { userId: user.id, tenantId, role: Role.MEMBER },
    });

    const result = await inviteWorkspaceOwner(form(tenantId, "already@example.test"));
    expect(result.ok).toBe(false);
  });

  it("rejects an address that is not an email, without writing anything", async () => {
    const before = await prismaService.auditEvent.count({ where: { tenantId } });
    const result = await inviteWorkspaceOwner(form(tenantId, "not-an-email"));
    expect(result.ok).toBe(false);
    expect(await prismaService.auditEvent.count({ where: { tenantId } })).toBe(before);
  });
});
