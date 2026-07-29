import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The welcome tour runs once per PERSON, not once per workspace.
 *
 * It teaches the app, so someone who has already skipped or finished it should
 * not meet it again for joining a second shop or switching between them — which
 * is what stamping only the active membership did. The profile menu still
 * replays it on demand, and that replay must stay harmless.
 */

const dbUrl = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(dbUrl);

const authState: { session: { user: { id: string } } } = { session: { user: { id: "" } } };

vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return {
    ...actual,
    requireSession: async () => authState.session,
  };
});

import { prismaService } from "@wezesha/db";
import { markWelcomed } from "@/lib/auth-actions";

const SLUGS = ["tour-shop-a", "tour-shop-b"];
const USER_ID = "tour-test-user";
const OTHER_USER_ID = "tour-other-user";

describe.skipIf(!runnable)("welcome tour stamp (local db)", () => {
  let tenantA = "";
  let tenantB = "";

  beforeAll(async () => {
    await cleanup();
    const [a, b] = await Promise.all(
      SLUGS.map((slug) =>
        prismaService.tenant.create({ data: { name: slug, slug, plan: "growth" } })
      )
    );
    tenantA = a!.id;
    tenantB = b!.id;

    await prismaService.user.create({
      data: { id: USER_ID, name: "Tour Tester", email: "tour-tester@example.test", emailVerified: true },
    });
    await prismaService.user.create({
      data: { id: OTHER_USER_ID, name: "Someone Else", email: "tour-other@example.test", emailVerified: true },
    });

    // The tester belongs to both shops; a second person belongs to one of them,
    // so the test can prove the stamp does not spill past its own user.
    await prismaService.membership.createMany({
      data: [
        { userId: USER_ID, tenantId: tenantA, role: "OWNER" },
        { userId: USER_ID, tenantId: tenantB, role: "MEMBER" },
        { userId: OTHER_USER_ID, tenantId: tenantA, role: "MEMBER" },
      ],
    });
    authState.session = { user: { id: USER_ID } };
  }, 60_000);

  afterAll(cleanup);

  async function cleanup() {
    await prismaService.membership.deleteMany({ where: { userId: { in: [USER_ID, OTHER_USER_ID] } } });
    await prismaService.user.deleteMany({ where: { id: { in: [USER_ID, OTHER_USER_ID] } } });
    await prismaService.tenant.deleteMany({ where: { slug: { in: SLUGS } } });
  }

  const mine = () =>
    prismaService.membership.findMany({
      where: { userId: USER_ID },
      select: { tenantId: true, welcomedAt: true },
      orderBy: { tenantId: "asc" },
    });

  it("stamps every workspace the person belongs to, not just the active one", async () => {
    expect((await mine()).every((m) => m.welcomedAt === null)).toBe(true);

    await markWelcomed();

    const after = await mine();
    expect(after).toHaveLength(2);
    expect(after.every((m) => m.welcomedAt !== null)).toBe(true);
  });

  it("leaves other people's memberships alone", async () => {
    const other = await prismaService.membership.findFirst({
      where: { userId: OTHER_USER_ID },
      select: { welcomedAt: true },
    });
    expect(other?.welcomedAt).toBeNull();
  });

  it("is harmless when the tour is replayed from the menu", async () => {
    const before = await mine();
    await markWelcomed();
    const after = await mine();
    // Already-stamped rows keep their original date: a replay is not a reset,
    // and re-stamping would make "first seen" drift every time someone rewatched.
    expect(after.map((m) => m.welcomedAt?.getTime())).toEqual(
      before.map((m) => m.welcomedAt?.getTime())
    );
  });

  it("stamps a workspace joined after the tour was already seen", async () => {
    const late = await prismaService.tenant.create({
      data: { name: "tour-shop-c", slug: "tour-shop-c", plan: "growth" },
    });
    try {
      await prismaService.membership.create({
        data: { userId: USER_ID, tenantId: late.id, role: "MEMBER" },
      });
      // A newly joined workspace starts unstamped, so the shell would auto-start
      // the tour there. The next skip/finish settles it for good.
      await markWelcomed();
      const row = await prismaService.membership.findFirst({
        where: { userId: USER_ID, tenantId: late.id },
        select: { welcomedAt: true },
      });
      expect(row?.welcomedAt).not.toBeNull();
    } finally {
      await prismaService.membership.deleteMany({ where: { tenantId: late.id } });
      await prismaService.tenant.delete({ where: { id: late.id } });
    }
  });
});
