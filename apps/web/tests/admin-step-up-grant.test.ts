import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Granting a step-up: the password check, the throttle, and who is not eligible
 * to step up at all.
 *
 * next/headers is stubbed with an in-memory jar because the grant is minted as
 * a cookie and there is no request scope here. Everything else — the password
 * hash, the atomic counter — is the real thing against the local database.
 */

const jar = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      jar.store.has(name) ? { name, value: jar.store.get(name)! } : undefined,
    set: (name: string, value: string) => {
      if (value === "") jar.store.delete(name);
      else jar.store.set(name, value);
    },
  }),
}));

const dbUrl = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(dbUrl);

const ADMIN_EMAIL = "step-up-admin@example.test";
const OTP_EMAIL = "step-up-otp@example.test";
const PASSWORD = "StepUp12345!";
const EMAILS = [ADMIN_EMAIL, OTP_EMAIL];

describe.skipIf(!runnable)("grantStepUp", () => {
  let prismaService: typeof import("@wezesha/db").prismaService;
  let stepUp: typeof import("../lib/admin/step-up");
  let adminId: string;
  let otpId: string;

  const actor = (sessionId = "sess-test") => ({
    userId: adminId,
    email: ADMIN_EMAIL,
    name: "Step Up",
    sessionId,
    viaFallback: false,
  });

  beforeAll(async () => {
    ({ prismaService } = await import("@wezesha/db"));
    stepUp = await import("../lib/admin/step-up");
    const { auth } = await import("../lib/auth");
    const ctx = await auth.$context;

    const users = await prismaService.user.findMany({
      where: { email: { in: EMAILS } },
      select: { id: true },
    });
    const stale = users.map((u) => u.id);
    await prismaService.platformAdmin.deleteMany({ where: { userId: { in: stale } } });
    await prismaService.account.deleteMany({ where: { userId: { in: stale } } });
    await prismaService.user.deleteMany({ where: { id: { in: stale } } });

    adminId = crypto.randomUUID();
    await prismaService.user.create({
      data: { id: adminId, name: "Step Up", email: ADMIN_EMAIL },
    });
    await prismaService.account.create({
      data: {
        id: crypto.randomUUID(),
        userId: adminId,
        accountId: adminId,
        providerId: "credential",
        // Hashed through the configured hasher, which is what the verify side
        // uses — importing scrypt directly would test a different function.
        password: await ctx.password.hash(PASSWORD),
      },
    });

    // Signed up with an email code: no credential account, no password.
    otpId = crypto.randomUUID();
    await prismaService.user.create({ data: { id: otpId, name: "Code Only", email: OTP_EMAIL } });
  }, 30_000);

  beforeEach(async () => {
    jar.store.clear();
    await prismaService.platformAdmin.deleteMany({ where: { userId: { in: [adminId, otpId] } } });
    await prismaService.platformAdmin.create({ data: { userId: adminId, email: ADMIN_EMAIL } });
  });

  afterAll(async () => {
    await prismaService.platformAdmin.deleteMany({ where: { userId: { in: [adminId, otpId] } } });
    await prismaService.account.deleteMany({ where: { userId: { in: [adminId, otpId] } } });
    await prismaService.user.deleteMany({ where: { id: { in: [adminId, otpId] } } });
    await prismaService.$disconnect();
  });

  it("mints a grant for the right password and clears the failure count", async () => {
    await prismaService.platformAdmin.update({
      where: { userId: adminId },
      data: { failedStepUps: 3 },
    });

    expect(await stepUp.grantStepUp(actor(), PASSWORD)).toEqual({ ok: true });
    expect(await stepUp.hasStepUp(actor())).toBe(true);
  });

  it("does not carry the grant into a new session for the same person", async () => {
    // The reported hole: sign out, sign back in, and walk into a customer's
    // workspace unchallenged. Nothing clears this cookie on the way out —
    // Better Auth owns sign-out and has never heard of it — so the grant has to
    // be worthless to the next session rather than merely tidied away.
    expect(await stepUp.grantStepUp(actor("session-one"), PASSWORD)).toEqual({ ok: true });
    expect(await stepUp.hasStepUp(actor("session-one"))).toBe(true);

    // Same user, same surviving cookie, different session.
    expect(await stepUp.hasStepUp(actor("session-two"))).toBe(false);

    const row = await prismaService.platformAdmin.findUnique({ where: { userId: adminId } });
    expect(row).toMatchObject({ failedStepUps: 0, lockedUntil: null });
  });

  it("refuses the wrong password, mints nothing, and counts the attempt", async () => {
    const result = await stepUp.grantStepUp(actor(), "not-my-password");
    expect(result).toMatchObject({ ok: false, reason: "wrong_password" });
    expect(await stepUp.hasStepUp(actor())).toBe(false);

    const row = await prismaService.platformAdmin.findUnique({ where: { userId: adminId } });
    expect(row?.failedStepUps).toBe(1);
  });

  it("locks out after too many wrong passwords, and then refuses the RIGHT one", async () => {
    for (let i = 0; i <= stepUp.STEPUP_MAX_ATTEMPTS; i++) {
      await stepUp.grantStepUp(actor(), "wrong");
    }

    // The correct password is refused while locked — the lock is on the attempt,
    // not on the guess, or it would be no lock at all.
    const result = await stepUp.grantStepUp(actor(), PASSWORD);
    expect(result).toMatchObject({ ok: false, reason: "locked" });
    expect(await stepUp.hasStepUp(actor())).toBe(false);

    const row = await prismaService.platformAdmin.findUnique({ where: { userId: adminId } });
    expect(row?.lockedUntil).toBeTruthy();
    expect(row!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it("opens a fresh window once the lock expires, rather than resuming at the old count", async () => {
    // Otherwise the first mistake after a lockout locks the account again.
    await prismaService.platformAdmin.update({
      where: { userId: adminId },
      data: { failedStepUps: 99, lockedUntil: new Date(Date.now() - 1000) },
    });

    expect(await stepUp.grantStepUp(actor(), PASSWORD)).toEqual({ ok: true });
  });

  it("concurrent wrong guesses each count — the counter is not read-then-written", async () => {
    // Deliberately below the lockout threshold: once a lock engages, further
    // attempts stop incrementing (that is the point of it), so a burst that
    // crosses the line has no exact expected count. Under the line the number
    // is exact — and a read-modify-write would land on 1 or 2 rather than 4.
    const burst = stepUp.STEPUP_MAX_ATTEMPTS - 1;
    await Promise.all(
      Array.from({ length: burst }, () => stepUp.grantStepUp(actor(), "wrong"))
    );

    const row = await prismaService.platformAdmin.findUnique({ where: { userId: adminId } });
    expect(row?.failedStepUps).toBe(burst);
    expect(row?.lockedUntil).toBeNull();
  });

  it("tells an account with no password apart from a wrong password", async () => {
    // "It says my password is wrong but I can sign in" is how this reports
    // itself if the two are conflated.
    await prismaService.platformAdmin.create({ data: { userId: otpId, email: OTP_EMAIL } });
    const result = await stepUp.grantStepUp(
      { userId: otpId, email: OTP_EMAIL, name: "Code Only", sessionId: "sess-test", viaFallback: false },
      "anything"
    );
    expect(result).toMatchObject({ ok: false, reason: "no_password" });
  });

  it("refuses a bootstrap admin, who has no row to hold a failure count", async () => {
    const result = await stepUp.grantStepUp({ ...actor(), sessionId: "sess-test", viaFallback: true }, PASSWORD);
    expect(result).toMatchObject({ ok: false, reason: "not_eligible" });
    expect(await stepUp.hasStepUp({ ...actor(), sessionId: "sess-test", viaFallback: true })).toBe(false);

    // And the attempt never reached the throttle, so it cannot be used to lock
    // a real admin out by guessing against their address.
    const row = await prismaService.platformAdmin.findUnique({ where: { userId: adminId } });
    expect(row?.failedStepUps).toBe(0);
  });

  it("refuses someone whose access was revoked between signing in and stepping up", async () => {
    await prismaService.platformAdmin.update({
      where: { userId: adminId },
      data: { revokedAt: new Date() },
    });
    const result = await stepUp.grantStepUp(actor(), PASSWORD);
    expect(result).toMatchObject({ ok: false, reason: "not_eligible" });
  });

  it("does not honour one admin's grant for another admin", async () => {
    await stepUp.grantStepUp(actor(), PASSWORD);
    expect(await stepUp.hasStepUp(actor())).toBe(true);
    expect(
      await stepUp.hasStepUp({ userId: otpId, email: OTP_EMAIL, name: "Code Only", sessionId: "sess-test", viaFallback: false })
    ).toBe(false);
  });
});
