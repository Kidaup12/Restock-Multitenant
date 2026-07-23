import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaSessionStore, sessionAuthorizeSocket } from "../src/auth";

/**
 * prismaSessionStore against the real session/membership tables. Skips when
 * no local service connection is configured (the unit suite still covers the
 * authorizer logic with a faked store).
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const IDS = {
  user: "wsgw-test-user",
  tenantA: "wsgw-test-tenant-a",
  tenantB: "wsgw-test-tenant-b",
  liveToken: "wsgw-test-live-token",
  expiredToken: "wsgw-test-expired-token",
};

describe.skipIf(!runnable)("sessionAuthorizeSocket (db-backed)", () => {
  const authorize = sessionAuthorizeSocket(prismaSessionStore());

  beforeAll(async () => {
    const { prismaService } = await import("@wezesha/db");
    await prismaService.user.deleteMany({ where: { id: IDS.user } });
    await prismaService.tenant.deleteMany({ where: { id: { in: [IDS.tenantA, IDS.tenantB] } } });

    await prismaService.user.create({
      data: {
        id: IDS.user,
        name: "wsgw-test",
        email: "wsgw-test@example.test",
        sessions: {
          create: [
            {
              id: `${IDS.liveToken}-id`,
              token: IDS.liveToken,
              expiresAt: new Date(Date.now() + 60_000),
            },
            {
              id: `${IDS.expiredToken}-id`,
              token: IDS.expiredToken,
              expiresAt: new Date(Date.now() - 60_000),
            },
          ],
        },
      },
    });
    // Two memberships with explicit ordering: A is the earlier (= active) one.
    await prismaService.tenant.create({
      data: {
        id: IDS.tenantB,
        name: "WSGW Test B",
        slug: IDS.tenantB,
        memberships: {
          create: { userId: IDS.user, createdAt: new Date("2026-02-01T00:00:00Z") },
        },
      },
    });
    await prismaService.tenant.create({
      data: {
        id: IDS.tenantA,
        name: "WSGW Test A",
        slug: IDS.tenantA,
        memberships: {
          create: { userId: IDS.user, createdAt: new Date("2026-01-01T00:00:00Z") },
        },
      },
    });
  });

  afterAll(async () => {
    const { prismaService } = await import("@wezesha/db");
    await prismaService.user.deleteMany({ where: { id: IDS.user } });
    await prismaService.tenant.deleteMany({ where: { id: { in: [IDS.tenantA, IDS.tenantB] } } });
    await prismaService.$disconnect();
  });

  it("resolves a live session to the earliest membership's tenant", async () => {
    await expect(authorize(IDS.liveToken)).resolves.toEqual({ tenantId: IDS.tenantA });
  });

  it("accepts the signed-cookie form of the same token", async () => {
    await expect(authorize(`${IDS.liveToken}.signature`)).resolves.toEqual({
      tenantId: IDS.tenantA,
    });
  });

  it("rejects expired and unknown sessions", async () => {
    await expect(authorize(IDS.expiredToken)).resolves.toBeNull();
    await expect(authorize("wsgw-test-no-such-token")).resolves.toBeNull();
  });
});
