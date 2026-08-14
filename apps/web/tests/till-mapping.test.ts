import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Mapping a till to a branch, end to end against the local database: an
 * unmapped till appears in the Sales queue, the server action the Locations
 * screen calls clears it, and a location id from another tenant is invisible to
 * the write. Session + revalidation are stubbed; the database work is real.
 * Skips when no local service connection is configured.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

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
import { getUnmappedTills } from "@/lib/data/pos-queues";
import { mapTillToLocation, unmapTill } from "../app/(shell)/settings/locations/actions";

const SLUGS = ["till-map-a", "till-map-b"];
const TILL = "Kilimani Till 2";

describe.skipIf(!runnable)("till mapping (local db)", () => {
  let tenantA: string;
  let tenantB: string;
  let locA: string;
  let locB: string;

  beforeAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: { in: SLUGS } } });
    const a = await prismaService.tenant.create({ data: { name: "Till Map A", slug: SLUGS[0]! } });
    const b = await prismaService.tenant.create({ data: { name: "Till Map B", slug: SLUGS[1]! } });
    tenantA = a.id;
    tenantB = b.id;
    const la = await prismaService.location.create({
      data: { tenantId: tenantA, name: "Kilimani Shop", locationType: "branch", roleStatus: "confirmed" },
    });
    const lb = await prismaService.location.create({
      data: { tenantId: tenantB, name: "Other Shop", locationType: "branch", roleStatus: "confirmed" },
    });
    locA = la.id;
    locB = lb.id;
    await prismaService.posSale.create({
      data: {
        tenantId: tenantA,
        externalId: "till-map-sale-1",
        date: new Date(),
        createdBy: "Cashier",
        warehouse: TILL,
      },
    });
  });

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    await prismaService.$disconnect();
  });

  function actAs(tenantId: string, permissions: unknown) {
    authState.session = { user: { id: "user-1", name: "Owner One", email: "owner@example.test" } };
    authState.membership = { tenantId, displayName: "Owner One", role: "OWNER", permissions };
  }

  it("queues a till that sold but maps to no branch", async () => {
    expect(await getUnmappedTills(tenantA)).toEqual([{ warehouse: TILL, salesCount: 1 }]);
  });

  it("rejects a member without manage_settings", async () => {
    actAs(tenantA, []); // explicit empty override — no permissions
    const result = await mapTillToLocation({ warehouseName: TILL, locationId: locA });
    expect(result).toEqual({ ok: false, error: "You don't have settings access." });
    expect(await getUnmappedTills(tenantA)).toHaveLength(1);
  });

  it("cannot map a till to another tenant's location (RLS)", async () => {
    actAs(tenantA, null);
    const result = await mapTillToLocation({ warehouseName: TILL, locationId: locB });
    expect(result).toEqual({ ok: false, error: "That branch no longer exists." });
    // Nothing was written for either tenant.
    expect(await prismaService.warehouseLocationMap.findMany({ where: { locationId: locB } })).toEqual([]);
    expect(await getUnmappedTills(tenantA)).toHaveLength(1);
  });

  it("maps the till, clears the queue, and writes an audit event", async () => {
    actAs(tenantA, null); // OWNER preset includes manage_settings
    expect(await mapTillToLocation({ warehouseName: TILL, locationId: locA })).toEqual({ ok: true });

    expect(await getUnmappedTills(tenantA)).toEqual([]);
    const rows = await prismaForTenant(tenantA).warehouseLocationMap.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId: tenantA, warehouseName: TILL, locationId: locA });

    const audits = await prismaForTenant(tenantA).auditEvent.findMany({
      where: { entity: "WarehouseLocationMap" },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ tenantId: tenantA, action: "till_mapped" });
    // Tenant B sees neither the mapping nor the audit row.
    expect(await prismaForTenant(tenantB).warehouseLocationMap.findMany()).toEqual([]);
    expect(
      await prismaForTenant(tenantB).auditEvent.findMany({ where: { entity: "WarehouseLocationMap" } }),
    ).toEqual([]);
  });

  it("re-maps the same till instead of failing on the unique key", async () => {
    const second = await prismaService.location.create({
      data: { tenantId: tenantA, name: "Westlands Shop", locationType: "branch", roleStatus: "confirmed" },
    });
    actAs(tenantA, null);
    expect(await mapTillToLocation({ warehouseName: TILL, locationId: second.id })).toEqual({ ok: true });

    const rows = await prismaForTenant(tenantA).warehouseLocationMap.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.locationId).toBe(second.id);
  });

  it("unmaps a till and puts it back in the queue", async () => {
    actAs(tenantA, null);
    expect(await unmapTill({ warehouseName: TILL })).toEqual({ ok: true });
    expect(await prismaForTenant(tenantA).warehouseLocationMap.findMany()).toEqual([]);
    expect(await getUnmappedTills(tenantA)).toEqual([{ warehouse: TILL, salesCount: 1 }]);
  });
});
