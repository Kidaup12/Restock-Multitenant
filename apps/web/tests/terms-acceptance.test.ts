import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { readTermsAcceptance, recordTermsAcceptance } from "../lib/auth/terms";
import { TERMS_VERSION } from "../lib/legal";

/**
 * Terms acceptance against the local database, with fixture rows this suite
 * creates and destroys.
 *
 * The case that carries the weight is the STALE one: a membership that accepted
 * an earlier version must read as not-current. A test that only checked
 * "acceptedTermsAt is set" would pass against an implementation that ignored
 * the version entirely — which is the implementation the schema comment used to
 * describe while nothing implemented it at all.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const SLUG = "terms-accept-test";
const EMAIL = "terms-accept@example.test";

describe.skipIf(!runnable)("terms acceptance (local db)", () => {
  let tenantId: string;
  let membershipId: string;

  beforeAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    await prismaService.user.deleteMany({ where: { email: EMAIL } });
    const tenant = await prismaService.tenant.create({
      data: { name: "Terms Accept Co", slug: SLUG },
    });
    const user = await prismaService.user.create({
      // User.id has no default in the schema — Better Auth supplies it.
      data: { id: "terms-accept-test-user", email: EMAIL, name: "Terms Tester" },
    });
    const membership = await prismaService.membership.create({
      data: { tenantId: tenant.id, userId: user.id, role: "OWNER" },
    });
    tenantId = tenant.id;
    membershipId = membership.id;
  });

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { id: tenantId } });
    await prismaService.user.deleteMany({ where: { email: EMAIL } });
    await prismaService.$disconnect();
  });

  it("reads as never accepted before anyone accepts", () => {
    expect(readTermsAcceptance({ acceptedTermsAt: null, acceptedTermsVersion: null })).toEqual({
      current: false,
      at: null,
      version: null,
    });
  });

  it("records the version alongside the timestamp", async () => {
    const before = new Date();
    const accepted = await recordTermsAcceptance(tenantId, membershipId);

    expect(accepted.current).toBe(true);
    expect(accepted.version).toBe(TERMS_VERSION);
    expect(accepted.at!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);

    const row = await prismaService.membership.findUniqueOrThrow({
      where: { id: membershipId },
      select: { acceptedTermsAt: true, acceptedTermsVersion: true },
    });
    expect(row.acceptedTermsVersion).toBe(TERMS_VERSION);
    expect(row.acceptedTermsAt).not.toBeNull();
  });

  it("an acceptance of an older version does not count as current", () => {
    const stale = readTermsAcceptance({
      acceptedTermsAt: new Date("2026-01-01T00:00:00.000Z"),
      acceptedTermsVersion: "1999-01-01",
    });
    expect(stale.current).toBe(false);
    // The record is kept, so the screen can say WHICH version they accepted.
    expect(stale.version).toBe("1999-01-01");
    expect(stale.at).not.toBeNull();
  });

  it("re-accepting after a version bump re-stamps both fields", async () => {
    await prismaService.membership.update({
      where: { id: membershipId },
      data: { acceptedTermsAt: new Date("2026-01-01T00:00:00.000Z"), acceptedTermsVersion: "old" },
    });
    expect(
      readTermsAcceptance(
        await prismaService.membership.findUniqueOrThrow({
          where: { id: membershipId },
          select: { acceptedTermsAt: true, acceptedTermsVersion: true },
        }),
      ).current,
    ).toBe(false);

    const again = await recordTermsAcceptance(tenantId, membershipId);
    expect(again.current).toBe(true);
    expect(again.version).toBe(TERMS_VERSION);
    expect(again.at!.getUTCFullYear()).toBeGreaterThan(2026 - 1);
  });
});
