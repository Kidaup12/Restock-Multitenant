import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The ordering-strategy action against the local database.
 *
 * The page decides which products count as best sellers and how hard the buy
 * list works to keep each group in stock — both move order quantities on the
 * next run, so what is proven here is that a save round-trips through the ENGINE
 * that consumes it, that a period the engine would not accept is refused before
 * anything is written, and that the gate is in the action rather than only
 * greyed out on screen.
 *
 * Works on its own throwaway workspaces, never the shared dev tenant, so it
 * cannot race a suite that re-seeds. Skips when no local service connection is
 * configured.
 */

const runnable = /localhost|127\.0\.0\.1/.test(process.env.SERVICE_DATABASE_URL ?? "");

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

import { prismaService } from "@wezesha/db";
import { DEFAULT_ABC_WINDOW_DAYS, resolveForecastKnobs } from "@wezesha/forecast";
import {
  saveOrderingStrategy,
  type OrderingStrategyInput,
} from "../app/(shell)/settings/ordering-strategy/actions";

const SLUG_A = "ordering-strategy-a";
const SLUG_B = "ordering-strategy-b";

/** A complete, valid payload; each test overrides only what it exercises. */
const VALID: OrderingStrategyInput = {
  methodA: "balanced",
  methodB: "lean_cash",
  methodC: "stay_in_stock",
  abcWindowDays: 30,
};

describe.skipIf(!runnable)("saveOrderingStrategy (local db)", () => {
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
    const [a, b] = await Promise.all([
      prismaService.tenant.create({ data: { name: "Strategy A", slug: SLUG_A } }),
      prismaService.tenant.create({ data: { name: "Strategy B", slug: SLUG_B } }),
    ]);
    tenantA = a.id;
    tenantB = b.id;
  }, 60_000);

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
    await prismaService.$disconnect();
  });

  function actAs(tenantId: string, permissions: unknown) {
    authState.session = { user: { id: "user-1", name: "Owner One", email: "owner@example.test" } };
    authState.membership = { tenantId, displayName: "Owner One", role: "OWNER", permissions };
  }

  const configRow = (tenantId: string) =>
    prismaService.tenantConfig.findUnique({ where: { tenantId } });

  it("reads a workspace that has chosen nothing as the engine's own period", async () => {
    expect(await configRow(tenantB)).toBeNull();
    expect(resolveForecastKnobs(await configRow(tenantB)).abcWindowDays).toBe(
      DEFAULT_ABC_WINDOW_DAYS,
    );
  });

  it("creates the row on first save, and the engine reads the chosen period", async () => {
    expect(await configRow(tenantA)).toBeNull();
    actAs(tenantA, null); // OWNER preset includes manage_settings

    expect(await saveOrderingStrategy(VALID)).toEqual({ ok: true });

    const config = await configRow(tenantA);
    expect(config).toMatchObject({ abcWindowDays: 30, methodA: "balanced" });
    // The knob the run actually classifies on, not just the column.
    expect(resolveForecastKnobs(config).abcWindowDays).toBe(30);
  });

  it("records the period change in the audit trail beside the buying styles", async () => {
    actAs(tenantA, null);
    expect(await saveOrderingStrategy({ ...VALID, abcWindowDays: 60 })).toEqual({ ok: true });

    const event = await prismaService.auditEvent.findFirst({
      where: { tenantId: tenantA, action: "ordering_strategy_changed" },
      orderBy: { createdAt: "desc" },
      select: { meta: true },
    });
    expect(event?.meta).toMatchObject({ abcWindowDays: { from: 30, to: 60 } });
  });

  it("refuses a period the engine would not accept, and writes nothing", async () => {
    actAs(tenantA, null);
    const before = await configRow(tenantA);

    for (const abcWindowDays of [0, 45, -30, 100_000]) {
      const result = await saveOrderingStrategy({ ...VALID, abcWindowDays });
      expect(result.ok, `a period of ${abcWindowDays} was accepted`).toBe(false);
    }

    // A stored period the engine ignores would read back into the form as a
    // choice that is in force when it is not.
    expect(await configRow(tenantA)).toEqual(before);
  });

  it("refuses a reader who cannot manage settings, in the action", async () => {
    actAs(tenantB, []); // no permissions
    const result = await saveOrderingStrategy(VALID);
    expect(result.ok).toBe(false);
    expect(await configRow(tenantB)).toBeNull();
  });

  it("touches only the caller's own workspace", async () => {
    const before = await configRow(tenantB);
    actAs(tenantA, null);
    expect(await saveOrderingStrategy({ ...VALID, abcWindowDays: 90 })).toEqual({ ok: true });
    expect(await configRow(tenantB)).toEqual(before);
  });
});
