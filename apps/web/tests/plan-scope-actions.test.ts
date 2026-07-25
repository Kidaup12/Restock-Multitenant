import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Saved planner scopes against the local database. Two things are proved:
 *  1. the round trip — save -> list -> the applied selection matches what was
 *     saved (the shape the scope bar's onChange consumes) -> delete;
 *  2. isolation — a scope belongs to one tenant AND one member. A different
 *     tenant can't see or delete it (RLS on SavedFilter), and a different member
 *     in the SAME tenant can't either (the userId + page filter).
 *
 * Session + active membership are stubbed so the test drives the actions as any
 * member would; the tenant client itself is the real RLS-scoped one. Skips when
 * no local database is configured.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const authState = vi.hoisted(() => ({
  session: null as { user: { id: string; name: string | null; email: string } } | null,
  membership: null as { tenantId: string; displayName: string | null; role: string } | null,
}));

vi.mock("@/lib/auth", () => ({
  requireSession: async () => authState.session,
  activeMembership: async () => authState.membership,
}));

import { prismaService } from "@wezesha/db";
import { deleteScope, listScopes, saveScope } from "../app/(shell)/plan/scope-actions";
import { EMPTY_SCOPE, type ScopeSelection } from "../app/(shell)/plan/scope-bar";

const SLUGS = ["scope-tenant-a", "scope-tenant-b"];

describe.skipIf(!runnable)("saved planner scopes (local db)", () => {
  let tenantA: string;
  let tenantB: string;
  const userA1 = "scope-user-a1";
  const userA2 = "scope-user-a2";
  const userB1 = "scope-user-b1";

  function actAs(tenantId: string, userId: string) {
    authState.session = { user: { id: userId, name: "Member", email: `${userId}@example.test` } };
    authState.membership = { tenantId, displayName: "Member", role: "OWNER" };
  }

  beforeAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: { in: SLUGS } } });
    tenantA = (await prismaService.tenant.create({ data: { name: "Scope A", slug: SLUGS[0]! } })).id;
    tenantB = (await prismaService.tenant.create({ data: { name: "Scope B", slug: SLUGS[1]! } })).id;
  });

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    await prismaService.$disconnect();
  });

  // Each test starts from a clean SavedFilter set for these tenants (service
  // client bypasses RLS, so it can reach across both).
  beforeEach(async () => {
    await prismaService.savedFilter.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
  });

  it("saves, lists (round-tripping the selection), then deletes", async () => {
    actAs(tenantA, userA1);
    const selection: ScopeSelection = {
      abc: ["A", "B"],
      category: ["Drinks"],
      supplier: [],
      leadBand: ["fast"],
    };

    const saved = await saveScope({ name: "A/B drinks, fast", selection });
    expect(saved.ok).toBe(true);

    const listed = await listScopes();
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.data).toHaveLength(1);
      expect(listed.data[0]!.name).toBe("A/B drinks, fast");
      // The applied shape is exactly what was saved — this is what onChange gets.
      expect(listed.data[0]!.selection).toEqual(selection);
    }

    if (saved.ok) {
      expect(await deleteScope({ id: saved.data.id })).toEqual({ ok: true, data: { id: saved.data.id } });
    }
    const after = await listScopes();
    expect(after.ok && after.data).toHaveLength(0);
  });

  it("validates the name and refuses without a workspace", async () => {
    actAs(tenantA, userA1);
    expect(await saveScope({ name: "   ", selection: EMPTY_SCOPE })).toMatchObject({ ok: false });
    expect(await saveScope({ name: "x".repeat(61), selection: EMPTY_SCOPE })).toMatchObject({
      ok: false,
    });

    authState.session = { user: { id: userA1, name: "Member", email: "m@example.test" } };
    authState.membership = null;
    expect(await listScopes()).toEqual({ ok: false, error: "You're not in a workspace." });
  });

  it("isolates by tenant: another tenant cannot see or delete the scope", async () => {
    actAs(tenantA, userA1);
    const saved = await saveScope({
      name: "tenant A only",
      selection: { abc: ["A"], category: [], supplier: [], leadBand: [] },
    });
    expect(saved.ok).toBe(true);

    // Tenant B sees nothing and cannot delete A's scope by its id.
    actAs(tenantB, userB1);
    const bList = await listScopes();
    expect(bList.ok && bList.data).toHaveLength(0);
    if (saved.ok) {
      expect(await deleteScope({ id: saved.data.id })).toMatchObject({ ok: false });
    }

    // A's scope is untouched.
    actAs(tenantA, userA1);
    const aList = await listScopes();
    expect(aList.ok && aList.data.map((s) => s.name)).toEqual(["tenant A only"]);
  });

  it("isolates by member within a tenant: a peer cannot see or delete it", async () => {
    actAs(tenantA, userA1);
    const saved = await saveScope({
      name: "A1 private",
      selection: { abc: [], category: ["Snacks"], supplier: [], leadBand: [] },
    });
    expect(saved.ok).toBe(true);

    // A different member of the SAME tenant sees none of A1's scopes...
    actAs(tenantA, userA2);
    const peerList = await listScopes();
    expect(peerList.ok && peerList.data).toHaveLength(0);
    // ...and cannot delete A1's scope even with its exact id.
    if (saved.ok) {
      expect(await deleteScope({ id: saved.data.id })).toMatchObject({ ok: false });
    }

    // It survives for its owner.
    actAs(tenantA, userA1);
    const ownerList = await listScopes();
    expect(ownerList.ok && ownerList.data.map((s) => s.name)).toEqual(["A1 private"]);
  });
});
