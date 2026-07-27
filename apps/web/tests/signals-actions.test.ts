import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The declare-a-signal server actions against the local database: the promo and
 * closure writes land on the right days, the permission gate holds, another
 * tenant can neither see nor remove them, and removing a promo soft-deletes it
 * (history the forecast may already have used stays). Session + revalidation
 * are stubbed; the database work is real. Skips without a local service
 * connection.
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
import {
  declareClosure,
  declarePromo,
  removeClosureDay,
  removePromo,
} from "../app/(shell)/settings/signals/actions";
import { getDeclaredSignals } from "../lib/data/signals";
import { dismissGapAsClosure } from "../lib/pos/match";

const SLUGS = ["signals-action-a", "signals-action-b"];

describe.skipIf(!runnable)("declared signals actions (local db)", () => {
  let tenantA: string;
  let tenantB: string;
  let locA: string;
  let locB: string;

  beforeAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: { in: SLUGS } } });
    const a = await prismaService.tenant.create({ data: { name: "Signals A", slug: SLUGS[0]! } });
    const b = await prismaService.tenant.create({ data: { name: "Signals B", slug: SLUGS[1]! } });
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
    await prismaService.product.create({
      data: { tenantId: tenantA, sku: "SIG-LIP-01", title: "Matte Lipstick", vendor: "Amara" },
    });
  });

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    await prismaService.$disconnect();
  });

  function actAs(tenantId: string, permissions: unknown = null) {
    authState.session = { user: { id: "user-1", name: "Owner One", email: "owner@example.test" } };
    authState.membership = { tenantId, displayName: "Owner One", role: "OWNER", permissions };
  }

  it("stores a declared promo on the exact days entered", async () => {
    actAs(tenantA);
    const result = await declarePromo({
      startDate: "2026-05-04",
      endDate: "2026-05-10",
      scope: "all",
      promoType: "giveaway",
      discountPct: "20",
      notes: "Opening week giveaway",
    });
    expect(result.ok).toBe(true);

    const promos = await prismaForTenant(tenantA).promo.findMany();
    expect(promos).toHaveLength(1);
    expect(promos[0]!.startDate.toISOString()).toBe("2026-05-04T00:00:00.000Z");
    expect(promos[0]!.endDate.toISOString()).toBe("2026-05-10T00:00:00.000Z");
    expect(promos[0]!.discountPct).toBe(20);
    expect(promos[0]!.scope).toBe("all");
    expect(promos[0]!.deletedAt).toBeNull();
  });

  it("rejects a backwards range, an unknown product code, and a member without settings access", async () => {
    actAs(tenantA);
    expect(
      await declarePromo({
        startDate: "2026-05-10",
        endDate: "2026-05-04",
        scope: "all",
        promoType: "discount",
      }),
    ).toMatchObject({ ok: false });

    expect(
      await declarePromo({
        startDate: "2026-05-04",
        endDate: "2026-05-05",
        scope: "sku",
        scopeValue: "NOT-A-SKU",
        promoType: "discount",
      }),
    ).toMatchObject({ ok: false });

    // Explicit empty override = every permission revoked, whatever the role.
    actAs(tenantA, []);
    expect(
      await declarePromo({
        startDate: "2026-05-04",
        endDate: "2026-05-05",
        scope: "all",
        promoType: "discount",
      }),
    ).toEqual({ ok: false, error: "You don't have settings access." });

    expect(await prismaForTenant(tenantA).promo.count()).toBe(1);
  });

  it("keeps a promo invisible and untouchable from another tenant", async () => {
    const promo = (await prismaForTenant(tenantA).promo.findFirstOrThrow()).id;

    actAs(tenantB);
    expect(await prismaForTenant(tenantB).promo.findMany()).toHaveLength(0);
    expect((await getDeclaredSignals(tenantB)).promos).toHaveLength(0);

    expect(await removePromo({ promoId: promo })).toMatchObject({ ok: false });
    const stillLive = await prismaService.promo.findUniqueOrThrow({ where: { id: promo } });
    expect(stillLive.deletedAt).toBeNull();
  });

  it("soft-deletes a promo: the row survives, the lists and future runs drop it", async () => {
    const promo = (await prismaForTenant(tenantA).promo.findFirstOrThrow()).id;

    actAs(tenantA);
    expect(await removePromo({ promoId: promo })).toMatchObject({ ok: true });

    const row = await prismaService.promo.findUniqueOrThrow({ where: { id: promo } });
    expect(row.deletedAt).not.toBeNull();
    expect((await getDeclaredSignals(tenantA)).promos).toHaveLength(0);

    // A second removal has nothing left to do.
    expect(await removePromo({ promoId: promo })).toMatchObject({ ok: false });
  });

  it("writes one closure row per day in the range and shares the writer with the sales-gap fix", async () => {
    actAs(tenantA);
    const declared = await declareClosure({
      locationId: locA,
      startDate: "2026-06-01",
      endDate: "2026-06-03",
      reason: "refit",
      note: "New shelving",
    });
    expect(declared).toMatchObject({ ok: true });

    const rows = await prismaForTenant(tenantA).locationClosure.findMany({ orderBy: { date: "asc" } });
    expect(rows.map((r) => r.date.toISOString().slice(0, 10))).toEqual([
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
    ]);
    expect(rows.every((r) => r.reason === "refit")).toBe(true);

    // The Sales screen's "Shop was closed" dismissal upserts the same row rather
    // than adding a second, contradictory one.
    expect(
      await dismissGapAsClosure(
        tenantA,
        { locationId: locA, dayKey: "2026-06-02" },
        { userId: "user-1", name: "Owner One" },
      ),
    ).toEqual({ ok: true });
    const afterDismiss = await prismaForTenant(tenantA).locationClosure.findMany();
    expect(afterDismiss).toHaveLength(3);
    expect(
      afterDismiss.find((r) => r.date.toISOString().startsWith("2026-06-02"))!.reason,
    ).toBe("closed");
  });

  it("won't close another tenant's location or remove its closed days", async () => {
    actAs(tenantA);
    expect(
      await declareClosure({
        locationId: locB,
        startDate: "2026-06-05",
        endDate: "2026-06-05",
        reason: "closed",
      }),
    ).toEqual({ ok: false, error: "That location no longer exists." });

    actAs(tenantB);
    expect(await removeClosureDay({ locationId: locA, dayKey: "2026-06-01" })).toMatchObject({
      ok: false,
    });
    expect(await prismaService.locationClosure.count({ where: { tenantId: tenantA } })).toBe(3);
  });

  it("removes one declared closed day", async () => {
    actAs(tenantA);
    expect(await removeClosureDay({ locationId: locA, dayKey: "2026-06-01" })).toMatchObject({
      ok: true,
    });
    const rows = await prismaForTenant(tenantA).locationClosure.findMany();
    expect(rows.map((r) => r.date.toISOString().slice(0, 10)).sort()).toEqual([
      "2026-06-02",
      "2026-06-03",
    ]);
  });
});
