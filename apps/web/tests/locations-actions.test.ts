import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The confirm-role server action against the local database: proves the
 * permission gate, the RLS-scoped write (a location id from another tenant is
 * invisible), and the audit trail. Session + revalidation are stubbed; the
 * database work is real. Skips when no local service connection is configured.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

// Controllable fake auth — set per test before calling the action.
const authState = vi.hoisted(() => ({
  session: null as { user: { id: string; name: string | null; email: string } } | null,
  membership: null as
    | { tenantId: string; displayName: string | null; role: string; permissions: unknown }
    | null,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({
  requireSession: async () => authState.session,
  activeMembership: async () => authState.membership,
}));

import { prismaForTenant, prismaService } from "@wezesha/db";
import { setLocationRole } from "../app/(shell)/settings/locations/actions";

const SLUGS = ["loc-action-a", "loc-action-b"];

describe.skipIf(!runnable)("setLocationRole (local db)", () => {
  let tenantA: string;
  let tenantB: string;
  let locA: string;
  let locB: string;

  beforeAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: { in: SLUGS } } });
    const a = await prismaService.tenant.create({ data: { name: "Loc Action A", slug: SLUGS[0]! } });
    const b = await prismaService.tenant.create({ data: { name: "Loc Action B", slug: SLUGS[1]! } });
    tenantA = a.id;
    tenantB = b.id;
    const la = await prismaService.location.create({
      data: { tenantId: tenantA, name: "Kilimani Shop", locationType: "branch", roleStatus: "assumed" },
    });
    const lb = await prismaService.location.create({
      data: { tenantId: tenantB, name: "Other Shop", locationType: "branch", roleStatus: "assumed" },
    });
    locA = la.id;
    locB = lb.id;
  });

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    await prismaService.$disconnect();
  });

  function actAs(tenantId: string, permissions: unknown) {
    authState.session = { user: { id: "user-1", name: "Owner One", email: "owner@example.test" } };
    authState.membership = { tenantId, displayName: "Owner One", role: "OWNER", permissions };
  }

  it("confirms a role and writes an RLS-scoped audit event", async () => {
    actAs(tenantA, null); // OWNER preset includes manage_settings
    const result = await setLocationRole({ locationId: locA, locationType: "warehouse" });
    expect(result).toEqual({ ok: true });

    const row = await prismaForTenant(tenantA).location.findUnique({ where: { id: locA } });
    expect(row?.locationType).toBe("warehouse");
    expect(row?.roleStatus).toBe("confirmed");

    const audits = await prismaForTenant(tenantA).auditEvent.findMany({
      where: { entity: "Location", entityId: locA },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ tenantId: tenantA, action: "role_confirmed" });
    expect((audits[0]!.meta as { to: string }).to).toBe("warehouse");
    // Tenant B cannot see A's audit row.
    expect(await prismaForTenant(tenantB).auditEvent.findMany({ where: { entity: "Location" } })).toEqual([]);
  });

  it("cannot touch another tenant's location (RLS)", async () => {
    actAs(tenantA, null);
    const result = await setLocationRole({ locationId: locB, locationType: "virtual" });
    expect(result).toEqual({ ok: false, error: "That location no longer exists." });
    // B's location is unchanged.
    const row = await prismaForTenant(tenantB).location.findUnique({ where: { id: locB } });
    expect(row?.locationType).toBe("branch");
    expect(row?.roleStatus).toBe("assumed");
  });

  it("rejects a member without manage_settings", async () => {
    actAs(tenantA, []); // explicit empty override — no permissions
    const result = await setLocationRole({ locationId: locA, locationType: "branch" });
    expect(result).toEqual({ ok: false, error: "You don't have settings access." });
  });

  it("rejects an unknown role value", async () => {
    actAs(tenantA, null);
    const result = await setLocationRole({ locationId: locA, locationType: "attic" });
    expect(result).toEqual({ ok: false, error: "Unknown role." });
  });
});
