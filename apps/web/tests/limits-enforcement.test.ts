import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Plan limits in blocking position: the member cap enforced by the real server
 * actions, not by a disabled button. Walks a workspace from "room to spare"
 * through the last-place warning to a refusal, then proves a per-tenant
 * override changes the answer. Session, cache revalidation, redirect and the
 * outbound email are stubbed; every count is real and re-checked independently
 * on the service client. Skips when no local database is configured.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const authState = vi.hoisted(() => ({
  session: null as { user: { id: string; name: string | null; email: string } } | null,
  membership: null as
    | {
        id: string;
        tenantId: string;
        role: string;
        permissions: unknown;
        tenant: { name: string };
      }
    | null,
  redirectedTo: null as string | null,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    authState.redirectedTo = to;
  },
}));
vi.mock("@/lib/auth", () => ({
  requireSession: async () => authState.session,
  getSession: async () => authState.session,
  activeMembership: async () => authState.membership,
  setWorkspaceCookie: async () => {},
}));
vi.mock("@/lib/email", () => ({ sendEmail: async () => {} }));

import { prismaAuth, prismaService } from "@wezesha/db";
import { checkLimit } from "../lib/limits/evaluate";
import { createInvite, getInvite } from "../lib/auth/invites";
import { inviteTeammate } from "../app/(shell)/settings/team/actions";
import { acceptInviteAction } from "../app/invite/[token]/actions";

const SLUG = "limits-enforcement-test";
const OWNER_EMAIL = "limits-owner@example.test";
const SECOND_EMAIL = "limits-second@example.test";
const THIRD_EMAIL = "limits-third@example.test";
const FOURTH_EMAIL = "limits-fourth@example.test";
const EMAILS = [OWNER_EMAIL, SECOND_EMAIL, THIRD_EMAIL, FOURTH_EMAIL];

/** The cap this workspace runs against — a per-tenant override, so the tiers
 *  in @wezesha/db stay untouched and the fixture stays small. */
const MAX_MEMBERS = 3;

describe.skipIf(!runnable)("plan limit enforcement (local db)", () => {
  let tenantId: string;
  const userIds = new Map<string, string>();
  let thirdToken = "";
  let fourthToken = "";

  async function memberCount(): Promise<number> {
    return prismaService.membership.count({ where: { tenantId } });
  }

  async function cleanup() {
    const stale = await prismaService.tenant.findMany({
      where: { slug: SLUG },
      select: { id: true },
    });
    for (const tenant of stale) {
      await prismaAuth.verification.deleteMany({
        where: { identifier: { startsWith: `invite:${tenant.id}:` } },
      });
    }
    await prismaService.user.deleteMany({ where: { email: { in: EMAILS } } });
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
  }

  beforeAll(async () => {
    await cleanup();
    const tenant = await prismaService.tenant.create({
      data: {
        name: "Limits Enforcement Test",
        slug: SLUG,
        plan: "starter",
        planLimits: { maxMembers: MAX_MEMBERS },
      },
    });
    tenantId = tenant.id;

    for (const email of EMAILS) {
      const user = await prismaService.user.create({
        data: { id: crypto.randomUUID(), name: email.split("@")[0]!, email },
      });
      userIds.set(email, user.id);
    }

    const ownerMembership = await prismaService.membership.create({
      data: { userId: userIds.get(OWNER_EMAIL)!, tenantId, role: "OWNER" },
    });
    authState.session = {
      user: { id: userIds.get(OWNER_EMAIL)!, name: "owner", email: OWNER_EMAIL },
    };
    authState.membership = {
      id: ownerMembership.id,
      tenantId,
      role: "OWNER",
      permissions: null,
      tenant: { name: tenant.name },
    };
  }, 30_000);

  afterAll(async () => {
    await cleanup();
    await prismaService.$disconnect();
  }, 30_000);

  it("under the limit: inviting and accepting both go through, quietly", async () => {
    expect(await memberCount()).toBe(1);
    const check = await checkLimit(tenantId, "invite_member");
    expect(check).toMatchObject({ allowed: true, used: 1, max: MAX_MEMBERS, message: null });

    const invited = await inviteTeammate({ email: SECOND_EMAIL, role: "MEMBER" });
    expect(invited).toEqual({ ok: true });

    const pending = await prismaAuth.verification.findMany({
      where: { identifier: `invite:${tenantId}:${SECOND_EMAIL}` },
      select: { id: true },
    });
    expect(pending).toHaveLength(1);

    authState.session = {
      user: { id: userIds.get(SECOND_EMAIL)!, name: "second", email: SECOND_EMAIL },
    };
    authState.redirectedTo = null;
    await acceptInviteAction(pending[0]!.id);
    expect(authState.redirectedTo).toBe("/today");
    expect(await memberCount()).toBe(2);
  });

  it("at the last place: warns, but the invite still succeeds", async () => {
    const check = await checkLimit(tenantId, "invite_member");
    expect(check.allowed).toBe(true);
    expect(check.used).toBe(MAX_MEMBERS - 1);
    expect(check.message).toContain(`${MAX_MEMBERS} team members`);

    // Two tokens minted while there is still room: the third fills the last
    // place, the fourth is the one that later meets the wall on acceptance.
    for (const email of [THIRD_EMAIL, FOURTH_EMAIL]) {
      const created = await createInvite({ tenantId, email, role: "MEMBER" });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      if (email === THIRD_EMAIL) thirdToken = created.invite.token;
      else fourthToken = created.invite.token;
    }

    authState.session = {
      user: { id: userIds.get(THIRD_EMAIL)!, name: "third", email: THIRD_EMAIL },
    };
    authState.redirectedTo = null;
    await acceptInviteAction(thirdToken);
    expect(authState.redirectedTo).toBe("/today");
    expect(await memberCount()).toBe(MAX_MEMBERS);
  });

  it("at the cap: the invite action refuses in plain language", async () => {
    authState.session = {
      user: { id: userIds.get(OWNER_EMAIL)!, name: "owner", email: OWNER_EMAIL },
    };
    const result = await inviteTeammate({ email: "someone-else@example.test", role: "MEMBER" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(`${MAX_MEMBERS} team members`);
    expect(result.error).toContain("bigger plan");
    // No token was minted for the refused invite.
    expect(
      await prismaAuth.verification.count({
        where: { identifier: `invite:${tenantId}:someone-else@example.test` },
      }),
    ).toBe(0);
  });

  it("at the cap: accepting an already-issued invite is refused by the action", async () => {
    authState.session = {
      user: { id: userIds.get(FOURTH_EMAIL)!, name: "fourth", email: FOURTH_EMAIL },
    };
    authState.redirectedTo = null;
    const result = await acceptInviteAction(fourthToken);

    expect(authState.redirectedTo).toBeNull();
    expect(result?.error).toContain("plan");
    // The write really did not happen, counted independently of the action.
    expect(await memberCount()).toBe(MAX_MEMBERS);
    expect(
      await prismaService.membership.count({
        where: { tenantId, userId: userIds.get(FOURTH_EMAIL)! },
      }),
    ).toBe(0);
    // A refusal must not burn the token — it works again once there is room.
    expect((await getInvite(fourthToken)).status).toBe("valid");
  });

  it("a per-tenant override lifts the cap and the same invite goes through", async () => {
    await prismaService.tenant.update({
      where: { id: tenantId },
      data: { planLimits: { maxMembers: MAX_MEMBERS + 1 } },
    });
    expect(await checkLimit(tenantId, "invite_member")).toMatchObject({
      allowed: true,
      max: MAX_MEMBERS + 1,
    });

    authState.session = {
      user: { id: userIds.get(FOURTH_EMAIL)!, name: "fourth", email: FOURTH_EMAIL },
    };
    authState.redirectedTo = null;
    await acceptInviteAction(fourthToken);

    expect(authState.redirectedTo).toBe("/today");
    expect(await memberCount()).toBe(MAX_MEMBERS + 1);
    expect(
      await prismaService.membership.count({
        where: { tenantId, userId: userIds.get(FOURTH_EMAIL)! },
      }),
    ).toBe(1);
  });
});
