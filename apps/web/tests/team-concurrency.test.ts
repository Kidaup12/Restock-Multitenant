import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The last-owner guard under concurrency, against the local database. Two
 * owners acting on each other at the same moment each read "2 owners" and each
 * clear a guard that was true when it was read and false by the time the write
 * lands — and a workspace with no owners has no self-service way back (OWNER
 * gates export, delete, and every role grant).
 *
 * Both calls need their OWN actor, so the fake session rides an
 * AsyncLocalStorage rather than a shared mutable variable — a module-level
 * "current user" would just serialise what the test is trying to overlap.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

type Actor = {
  session: { user: { id: string; name: string | null; email: string } };
  membership: { id: string; tenantId: string; role: string; permissions: unknown };
};

const auth = vi.hoisted(() => ({
  actors: null as { getStore(): Actor | undefined } | null,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({
  requireSession: async () => auth.actors!.getStore()!.session,
  activeMembership: async () => auth.actors!.getStore()!.membership,
}));

import { AsyncLocalStorage } from "node:async_hooks";
import { prismaService } from "@wezesha/db";
import { changeMemberRole, removeMember } from "../app/(shell)/settings/team/actions";

const actors = new AsyncLocalStorage<Actor>();
auth.actors = actors;

const SLUG = "team-race-tenant";
const EMAILS = ["team-race-1@example.test", "team-race-2@example.test"];

describe.skipIf(!runnable)("last-owner guard under concurrency (local db)", () => {
  let tenantId: string;
  const userIds: string[] = [];

  beforeAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    await prismaService.user.deleteMany({ where: { email: { in: EMAILS } } });
    const tenant = await prismaService.tenant.create({
      data: { name: "Team Race", slug: SLUG },
    });
    tenantId = tenant.id;
    for (const email of EMAILS) {
      const user = await prismaService.user.create({
        data: { id: crypto.randomUUID(), name: email, email },
      });
      userIds.push(user.id);
    }
  }, 30_000);

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { id: tenantId } });
    await prismaService.user.deleteMany({ where: { email: { in: EMAILS } } });
    await prismaService.$disconnect();
  }, 30_000);

  /** Reset the workspace to exactly two owners and return their membership ids. */
  async function twoOwners(): Promise<string[]> {
    await prismaService.membership.deleteMany({ where: { tenantId } });
    const ids: string[] = [];
    for (const userId of userIds) {
      const membership = await prismaService.membership.create({
        data: { userId, tenantId, role: "OWNER" },
      });
      ids.push(membership.id);
    }
    return ids;
  }

  function as(membershipId: string, userId: string) {
    return {
      session: { user: { id: userId, name: "Owner", email: "owner@example.test" } },
      membership: { id: membershipId, tenantId, role: "OWNER", permissions: null },
    } satisfies Actor;
  }

  it("two owners demoting each other can't leave the workspace ownerless", async () => {
    for (let round = 0; round < 3; round++) {
      const [a, b] = await twoOwners();
      const results = await Promise.all([
        actors.run(as(a!, userIds[0]!), () =>
          changeMemberRole({ membershipId: b!, role: "MEMBER" })
        ),
        actors.run(as(b!, userIds[1]!), () =>
          changeMemberRole({ membershipId: a!, role: "MEMBER" })
        ),
      ]);

      const owners = await prismaService.membership.count({
        where: { tenantId, role: "OWNER" },
      });
      expect(owners).toBeGreaterThanOrEqual(1);
      // Only one demotion is allowed to have happened.
      expect(results.filter((r) => r.ok)).toHaveLength(1);
    }
  });

  it("two owners removing each other can't leave the workspace ownerless", async () => {
    for (let round = 0; round < 3; round++) {
      const [a, b] = await twoOwners();
      const results = await Promise.all([
        actors.run(as(a!, userIds[0]!), () => removeMember({ membershipId: b! })),
        actors.run(as(b!, userIds[1]!), () => removeMember({ membershipId: a! })),
      ]);

      const owners = await prismaService.membership.count({
        where: { tenantId, role: "OWNER" },
      });
      expect(owners).toBeGreaterThanOrEqual(1);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
    }
  });
});
