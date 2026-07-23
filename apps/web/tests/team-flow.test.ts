import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Invite token lifecycle and workspace resolution against the local database
 * (same harness as auth-flow: real route handler for signup, real Prisma
 * clients — including the RLS-enforced tenant client for the Membership
 * write). Skips when no local service connection is configured.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const OWNER_EMAIL = "team-flow-owner@example.test";
const INVITEE_EMAIL = "team-flow-invitee@example.test";
const OUTSIDER_EMAIL = "team-flow-outsider@example.test";
const LATE_EMAIL = "team-flow-late@example.test";
const EMAILS = [OWNER_EMAIL, INVITEE_EMAIL, OUTSIDER_EMAIL, LATE_EMAIL];
const SLUGS = ["team-flow-a", "team-flow-b", "team-flow-c"];

const base = "http://auth-flow.test";

function post(path: string, body: unknown): Request {
  return new Request(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify(body),
  });
}

type Db = typeof import("@wezesha/db");

async function cleanup(db: Db) {
  const tenants = await db.prismaService.tenant.findMany({
    where: { slug: { in: SLUGS } },
    select: { id: true },
  });
  for (const tenant of tenants) {
    await db.prismaAuth.verification.deleteMany({
      where: { identifier: { startsWith: `invite:${tenant.id}:` } },
    });
  }
  await db.prismaService.user.deleteMany({ where: { email: { in: EMAILS } } });
  await db.prismaService.tenant.deleteMany({ where: { slug: { in: SLUGS } } });
}

describe.skipIf(!runnable)("team invites + workspace resolution (local db)", () => {
  let db: Db;
  let invites: typeof import("../lib/auth/invites");
  let authLib: typeof import("../lib/auth");
  let tenantA: { id: string };
  let tenantB: { id: string };
  let tenantC: { id: string };
  let ownerId: string;
  let token = "";

  // Same allowance as testTimeout in vitest.config.ts — fixture setup hits
  // the real database and can crawl on a loaded machine.
  beforeAll(async () => {
    db = await import("@wezesha/db");
    invites = await import("../lib/auth/invites");
    authLib = await import("../lib/auth");
    await cleanup(db);

    ownerId = crypto.randomUUID();
    await db.prismaService.user.create({
      data: { id: ownerId, name: "team-flow-owner", email: OWNER_EMAIL },
    });
    tenantA = await db.prismaService.tenant.create({
      data: { name: "Team Flow A", slug: SLUGS[0] },
    });
    tenantB = await db.prismaService.tenant.create({
      data: { name: "Team Flow B", slug: SLUGS[1] },
    });
    tenantC = await db.prismaService.tenant.create({
      data: { name: "Team Flow C", slug: SLUGS[2] },
    });
    // Two memberships with a deterministic "earliest".
    await db.prismaService.membership.create({
      data: {
        userId: ownerId,
        tenantId: tenantA.id,
        role: "OWNER",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    });
    await db.prismaService.membership.create({
      data: {
        userId: ownerId,
        tenantId: tenantB.id,
        role: "ADMIN",
        createdAt: new Date("2026-01-02T00:00:00Z"),
      },
    });
  }, 30_000);

  afterAll(async () => {
    await cleanup(db);
    await db.prismaService.$disconnect();
  }, 30_000);

  it("creates an invite token in the Verification table", async () => {
    const result = await invites.createInvite({
      tenantId: tenantA.id,
      email: `  ${INVITEE_EMAIL.toUpperCase()}  `,
      role: "MEMBER",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    token = result.invite.token;
    expect(result.invite.email).toBe(INVITEE_EMAIL);

    const row = await db.prismaAuth.verification.findUnique({
      where: { id: token },
    });
    expect(row?.identifier).toBe(`invite:${tenantA.id}:${INVITEE_EMAIL}`);
    expect(row?.value).toBe("MEMBER");
    const ttl = row!.expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
  });

  it("re-inviting replaces the pending token", async () => {
    const result = await invites.createInvite({
      tenantId: tenantA.id,
      email: INVITEE_EMAIL,
      role: "ADMIN",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invite.token).not.toBe(token);

    expect((await invites.getInvite(token)).status).toBe("invalid");
    const rows = await db.prismaAuth.verification.count({
      where: { identifier: `invite:${tenantA.id}:${INVITEE_EMAIL}` },
    });
    expect(rows).toBe(1);
    token = result.invite.token;
  });

  it("rejects inviting an existing member", async () => {
    const result = await invites.createInvite({
      tenantId: tenantA.id,
      email: OWNER_EMAIL,
      role: "MEMBER",
    });
    expect(result.ok).toBe(false);
  });

  it("resolves a valid token to workspace, email, and role", async () => {
    const lookup = await invites.getInvite(token);
    expect(lookup.status).toBe("valid");
    if (lookup.status !== "valid") return;
    expect(lookup.tenantName).toBe("Team Flow A");
    expect(lookup.invite.email).toBe(INVITEE_EMAIL);
    expect(lookup.invite.role).toBe("ADMIN");
  });

  it("rejects acceptance for a mismatched email without consuming the token", async () => {
    const outsiderId = crypto.randomUUID();
    await db.prismaService.user.create({
      data: { id: outsiderId, name: "team-flow-outsider", email: OUTSIDER_EMAIL },
    });
    const result = await invites.acceptInvite({
      token,
      userId: outsiderId,
      userEmail: OUTSIDER_EMAIL,
    });
    expect(result).toEqual({ ok: false, code: "email_mismatch" });
    expect((await invites.getInvite(token)).status).toBe("valid");
  });

  it("signup-first then accept creates the membership and consumes the token", async () => {
    const { POST } = await import("../app/api/auth/[...all]/route");
    const res = await POST(
      post("/api/auth/sign-up/email", {
        email: INVITEE_EMAIL,
        password: "team-flow-pass-1",
        name: "team-flow-invitee",
      }),
    );
    expect(res.status).toBe(200);

    const invitee = await db.prismaService.user.findUnique({
      where: { email: INVITEE_EMAIL },
    });
    expect(invitee).not.toBeNull();

    const result = await invites.acceptInvite({
      token,
      userId: invitee!.id,
      userEmail: INVITEE_EMAIL.toUpperCase(),
    });
    expect(result).toEqual({
      ok: true,
      tenantId: tenantA.id,
      alreadyMember: false,
    });

    const membership = await db.prismaService.membership.findUnique({
      where: { userId_tenantId: { userId: invitee!.id, tenantId: tenantA.id } },
    });
    expect(membership?.role).toBe("ADMIN");
    expect(membership?.welcomedAt).toBeNull();
    expect(
      await db.prismaAuth.verification.findUnique({ where: { id: token } }),
    ).toBeNull();
  });

  it("treats a consumed token as invalid", async () => {
    const invitee = await db.prismaService.user.findUnique({
      where: { email: INVITEE_EMAIL },
    });
    const result = await invites.acceptInvite({
      token,
      userId: invitee!.id,
      userEmail: INVITEE_EMAIL,
    });
    expect(result).toEqual({ ok: false, code: "invalid" });
  });

  it("rejects expired invites and sweeps them from the pending list", async () => {
    const created = await invites.createInvite({
      tenantId: tenantA.id,
      email: LATE_EMAIL,
      role: "MEMBER",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await db.prismaAuth.verification.update({
      where: { id: created.invite.token },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await invites.getInvite(created.invite.token)).status).toBe("expired");

    const pending = await invites.listInvites(tenantA.id);
    expect(pending.map((invite) => invite.email)).not.toContain(LATE_EMAIL);
    expect(
      await db.prismaAuth.verification.findUnique({
        where: { id: created.invite.token },
      }),
    ).toBeNull();
  });

  it("cancels a pending invite, but only through its own tenant", async () => {
    const created = await invites.createInvite({
      tenantId: tenantA.id,
      email: LATE_EMAIL,
      role: "MEMBER",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(await invites.cancelInvite(tenantB.id, created.invite.token)).toBe(false);
    expect((await invites.getInvite(created.invite.token)).status).toBe("valid");
    expect(await invites.cancelInvite(tenantA.id, created.invite.token)).toBe(true);
    expect((await invites.getInvite(created.invite.token)).status).toBe("invalid");
  });

  it("workspace resolution honors a real membership preference", async () => {
    const active = await authLib.resolveActiveMembership(ownerId, tenantB.id);
    expect(active?.tenantId).toBe(tenantB.id);
  });

  it("workspace resolution falls back to the earliest membership", async () => {
    // No preference.
    expect(
      (await authLib.resolveActiveMembership(ownerId, null))?.tenantId,
    ).toBe(tenantA.id);
    // Preference for a workspace the user doesn't belong to.
    expect(
      (await authLib.resolveActiveMembership(ownerId, tenantC.id))?.tenantId,
    ).toBe(tenantA.id);
    // A forged preference for someone else's workspace.
    const invitee = await db.prismaService.user.findUnique({
      where: { email: INVITEE_EMAIL },
    });
    expect(
      (await authLib.resolveActiveMembership(invitee!.id, tenantB.id))?.tenantId,
    ).toBe(tenantA.id);
  });
});
