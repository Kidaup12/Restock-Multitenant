import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PLATFORM_TENANT_ID, prismaService } from "@wezesha/db";
import {
  grantPlatformAdmin,
  listPlatformAdmins,
  revokePlatformAdmin,
} from "../lib/admin/admins";
import type { AdminActor } from "../lib/admin/gate";

/**
 * Granting and revoking console access from inside the console.
 *
 * The two refusals are the point of the feature, not decoration: an admin who
 * revokes themselves, or revokes the last remaining admin, locks everyone out of
 * the surface that grants access — and the only way back is a CLI run against
 * production. Both are tested here, and the audit row is checked because
 * "who let this person in" is the question the table exists to answer and the
 * columns for it sat null until now.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const IDS = ["admins-test-a", "admins-test-b", "admins-test-c"];

const actorFor = (userId: string, email: string): AdminActor => ({
  userId,
  sessionId: "session-1",
  email,
  name: "Operator",
  viaFallback: false,
});

describe.skipIf(!runnable)("platform admin grant/revoke (local db)", () => {
  /** "The last admin standing" is a fact about the whole table, so this suite
   *  has to own it. Whatever the local database held is put back afterwards. */
  let borrowed: Awaited<ReturnType<typeof prismaService.platformAdmin.findMany>> = [];

  beforeAll(async () => {
    borrowed = await prismaService.platformAdmin.findMany();
    await prismaService.platformAdmin.deleteMany({});
  });

  afterAll(async () => {
    await prismaService.platformAdmin.deleteMany({});
    if (borrowed.length > 0) {
      await prismaService.platformAdmin.createMany({ data: borrowed });
    }
    await prismaService.user.deleteMany({ where: { id: { in: IDS } } });
    const restored = await prismaService.platformAdmin.count();
    if (restored !== borrowed.length) {
      throw new Error(`platform admin rows not restored: ${restored} of ${borrowed.length}`);
    }
    await prismaService.$disconnect();
  });

  beforeEach(async () => {
    await prismaService.auditEvent.deleteMany({
      where: { tenantId: PLATFORM_TENANT_ID, action: { in: ["admin_granted", "admin_revoked"] } },
    });
    await prismaService.platformAdmin.deleteMany({ where: { userId: { in: IDS } } });
    await prismaService.user.deleteMany({ where: { id: { in: IDS } } });
    for (const id of IDS) {
      await prismaService.user.create({
        data: { id, email: `${id}@wezesha.test`, name: `User ${id}`, emailVerified: true },
      });
    }
    // A seeded first admin, as the bootstrap script writes it: no granter.
    await prismaService.platformAdmin.create({
      data: { userId: IDS[0]!, email: `${IDS[0]}@wezesha.test` },
    });
  });

  const actorA = () => actorFor(IDS[0]!, `${IDS[0]}@wezesha.test`);

  it("grants access to an existing account and records who did it", async () => {
    const result = await grantPlatformAdmin(actorA(), `${IDS[1]}@WEZESHA.test`);
    expect(result.ok).toBe(true);

    const row = await prismaService.platformAdmin.findUnique({ where: { userId: IDS[1]! } });
    expect(row).toMatchObject({
      grantedByUserId: IDS[0],
      grantedByEmail: `${IDS[0]}@wezesha.test`,
      revokedAt: null,
    });
    // The address is normalised on the way in, whatever case was typed.
    expect(row!.email).toBe(`${IDS[1]}@wezesha.test`);

    const audit = await prismaService.auditEvent.findFirst({
      where: { tenantId: PLATFORM_TENANT_ID, action: "admin_granted" },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actorUserId).toBe(IDS[0]);
    expect(audit!.meta).toMatchObject({ subjectEmail: `${IDS[1]}@wezesha.test` });
  });

  it("refuses an address with no account behind it", async () => {
    const result = await grantPlatformAdmin(actorA(), "nobody@wezesha.test");
    expect(result).toMatchObject({ ok: false });
    expect(await prismaService.platformAdmin.count()).toBe(1);
  });

  it("refuses to grant twice", async () => {
    await grantPlatformAdmin(actorA(), `${IDS[1]}@wezesha.test`);
    const again = await grantPlatformAdmin(actorA(), `${IDS[1]}@wezesha.test`);
    expect(again).toMatchObject({ ok: false });
  });

  it("will not let an admin revoke themselves", async () => {
    await grantPlatformAdmin(actorA(), `${IDS[1]}@wezesha.test`);
    const result = await revokePlatformAdmin(actorA(), IDS[0]!);
    expect(result).toMatchObject({ ok: false });
    expect((await prismaService.platformAdmin.findUnique({ where: { userId: IDS[0]! } }))!.revokedAt).toBeNull();
  });

  it("will not revoke the last admin standing", async () => {
    // Only the seeded admin exists; someone else tries to remove them.
    const other = actorFor(IDS[1]!, `${IDS[1]}@wezesha.test`);
    const result = await revokePlatformAdmin(other, IDS[0]!);
    expect(result).toMatchObject({ ok: false });
    expect(await prismaService.platformAdmin.count({ where: { revokedAt: null } })).toBe(1);
  });

  it("revokes another admin, stamping who did it, and keeps the row", async () => {
    await grantPlatformAdmin(actorA(), `${IDS[1]}@wezesha.test`);
    const result = await revokePlatformAdmin(actorA(), IDS[1]!);
    expect(result.ok).toBe(true);

    const row = await prismaService.platformAdmin.findUnique({ where: { userId: IDS[1]! } });
    expect(row).not.toBeNull(); // history survives the access
    expect(row!.revokedAt).not.toBeNull();
    expect(row!.revokedByUserId).toBe(IDS[0]);

    const audit = await prismaService.auditEvent.findFirst({
      where: { tenantId: PLATFORM_TENANT_ID, action: "admin_revoked" },
    });
    expect(audit).not.toBeNull();
  });

  it("re-grants a revoked admin on their existing row, clearing the lockout", async () => {
    await grantPlatformAdmin(actorA(), `${IDS[1]}@wezesha.test`);
    await prismaService.platformAdmin.update({
      where: { userId: IDS[1]! },
      data: { failedStepUps: 3, lockedUntil: new Date(Date.now() + 60_000) },
    });
    await revokePlatformAdmin(actorA(), IDS[1]!);

    const again = await grantPlatformAdmin(actorA(), `${IDS[1]}@wezesha.test`);
    expect(again.ok).toBe(true);

    const row = await prismaService.platformAdmin.findUnique({ where: { userId: IDS[1]! } });
    expect(row).toMatchObject({ revokedAt: null, revokedByUserId: null, failedStepUps: 0 });
    expect(row!.lockedUntil).toBeNull();
    // Still one row, not a duplicate seat.
    expect(await prismaService.platformAdmin.count({ where: { userId: IDS[1]! } })).toBe(1);
  });

  it("lists live and revoked, marking the caller and the bootstrap row", async () => {
    await grantPlatformAdmin(actorA(), `${IDS[1]}@wezesha.test`);
    await grantPlatformAdmin(actorA(), `${IDS[2]}@wezesha.test`);
    await revokePlatformAdmin(actorA(), IDS[2]!);

    const rows = (await listPlatformAdmins(actorA())).filter((r) => IDS.includes(r.userId));
    const byId = new Map(rows.map((r) => [r.userId, r]));

    expect(byId.get(IDS[0]!)).toMatchObject({ isSelf: true, seeded: true, revokedAt: null });
    expect(byId.get(IDS[1]!)).toMatchObject({
      isSelf: false,
      seeded: false,
      grantedByEmail: `${IDS[0]}@wezesha.test`,
    });
    expect(byId.get(IDS[2]!)!.revokedAt).not.toBeNull();
    expect(byId.get(IDS[2]!)!.revokedByEmail).toBe(`${IDS[0]}@wezesha.test`);
  });
});
