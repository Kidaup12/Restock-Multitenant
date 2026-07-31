import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prismaService } from "../src/client";
import { PLATFORM_TENANT_ID } from "../src/platform-tenant";
import { bootstrapPlatformAdmin } from "../scripts/bootstrap-platform-admin";

/**
 * The bootstrap grant. Its refusals matter more than its success: this is the
 * one path that mints platform access with nobody's approval, so it has to be
 * hard to run by accident and impossible to run into a state that locks the
 * person out of the console it just gave them.
 */

const dbUrl = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(dbUrl);

const WITH_PASSWORD = "bootstrap-pw@example.test";
const OTP_ONLY = "bootstrap-otp@example.test";
const EMAILS = [WITH_PASSWORD, OTP_ONLY];

describe.skipIf(!runnable)("bootstrapPlatformAdmin", () => {
  let userId: string;
  let otpUserId: string;

  async function cleanup() {
    const users = await prismaService.user.findMany({
      where: { email: { in: EMAILS } },
      select: { id: true },
    });
    const ids = users.map((u) => u.id);
    await prismaService.platformAdmin.deleteMany({ where: { userId: { in: ids } } });
    await prismaService.auditEvent.deleteMany({ where: { entityId: { in: ids } } });
    await prismaService.account.deleteMany({ where: { userId: { in: ids } } });
    await prismaService.user.deleteMany({ where: { id: { in: ids } } });
  }

  beforeAll(async () => {
    await cleanup();

    userId = crypto.randomUUID();
    await prismaService.user.create({
      data: { id: userId, name: "Has Password", email: WITH_PASSWORD },
    });
    await prismaService.account.create({
      data: {
        id: crypto.randomUUID(),
        userId,
        accountId: userId,
        providerId: "credential",
        password: "scrypt:not-a-real-hash",
      },
    });

    // Signed up through the email-code path: a User with no credential Account.
    otpUserId = crypto.randomUUID();
    await prismaService.user.create({
      data: { id: otpUserId, name: "Code Only", email: OTP_ONLY },
    });
  });

  beforeEach(async () => {
    await prismaService.platformAdmin.deleteMany({ where: { userId: { in: [userId, otpUserId] } } });
  });

  afterAll(async () => {
    await cleanup();
    await prismaService.$disconnect();
  });

  it("refuses an address that is not an email", async () => {
    const result = await bootstrapPlatformAdmin("not-an-address");
    expect(result.ok).toBe(false);
  });

  it("refuses someone with no account rather than creating one", async () => {
    const result = await bootstrapPlatformAdmin("nobody-here@example.test");
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toMatch(/sign up/i);
    expect(
      await prismaService.platformAdmin.count({ where: { email: "nobody-here@example.test" } })
    ).toBe(0);
  });

  it("refuses an email-code-only account, because step-up would lock them out", async () => {
    // The failure this prevents is silent: they would reach the console, then
    // find every mutation answering "wrong password" to a password they do not
    // have — including the revoke that would let anyone fix it.
    const result = await bootstrapPlatformAdmin(OTP_ONLY);
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toMatch(/password/i);
    expect(await prismaService.platformAdmin.count({ where: { userId: otpUserId } })).toBe(0);
  });

  it("grants access, records no granter, and anchors the audit row to the platform workspace", async () => {
    const result = await bootstrapPlatformAdmin(WITH_PASSWORD.toUpperCase());
    expect(result).toMatchObject({ ok: true, status: "granted", userId });

    const row = await prismaService.platformAdmin.findUnique({ where: { userId } });
    expect(row).toMatchObject({
      email: WITH_PASSWORD, // normalised, whatever case was typed
      grantedByUserId: null, // nobody had the standing to grant this one
      revokedAt: null,
    });

    const event = await prismaService.auditEvent.findFirst({
      where: { entityId: userId, action: "platform_admin_granted" },
      orderBy: { createdAt: "desc" },
    });
    expect(event?.tenantId).toBe(PLATFORM_TENANT_ID);
    expect(event?.entity).toBe("PlatformAdmin");
    expect(event?.meta).toMatchObject({ via: "bootstrap" });
  });

  it("is idempotent: a second run changes nothing and says so", async () => {
    await bootstrapPlatformAdmin(WITH_PASSWORD);
    const before = await prismaService.platformAdmin.findUnique({ where: { userId } });

    const again = await bootstrapPlatformAdmin(WITH_PASSWORD);
    expect(again).toMatchObject({ ok: true, status: "already" });

    const after = await prismaService.platformAdmin.findUnique({ where: { userId } });
    expect(after?.grantedAt).toEqual(before?.grantedAt);
    expect(await prismaService.platformAdmin.count({ where: { userId } })).toBe(1);
  });

  it("restores a revoked admin, reports it as a restore, and clears the lockout", async () => {
    await bootstrapPlatformAdmin(WITH_PASSWORD);
    await prismaService.platformAdmin.update({
      where: { userId },
      data: { revokedAt: new Date(), revokedByUserId: "someone", failedStepUps: 5, lockedUntil: new Date() },
    });

    const result = await bootstrapPlatformAdmin(WITH_PASSWORD);
    // Distinguished from a fresh grant on purpose: an accidental re-run should
    // not quietly undo a deliberate revocation without saying that is what it did.
    expect(result).toMatchObject({ ok: true, status: "restored" });

    const row = await prismaService.platformAdmin.findUnique({ where: { userId } });
    expect(row).toMatchObject({
      revokedAt: null,
      revokedByUserId: null,
      failedStepUps: 0,
      lockedUntil: null,
    });
  });
});
