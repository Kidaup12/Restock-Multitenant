import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The workspace-settings action against the local database. Proves the four
 * things that make it safe to hand a shop owner: the save round-trips through
 * the readers that consume it, the permission gate is enforced in the action
 * (not just greyed out in the UI), a save touches only the caller's own
 * workspace, and a tenant with no TenantConfig row still reads pure defaults.
 *
 * Expectations are recomputed independently on prismaService (and through the
 * real getters), never from the action's own return value. Skips when no local
 * service connection is configured.
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

import { prismaService } from "@wezesha/db";
import { METHOD_DEFAULTS, resolveForecastKnobs } from "@wezesha/forecast";
import { DEV_TENANT_NAME, seedDev } from "../../../packages/db/scripts/seed-dev";
import { DEFAULT_DEAD_STOCK_DAYS, getTodayMetrics } from "../lib/data/today";
import { saveWorkspaceSettings, type WorkspaceSettingsInput } from "../app/(shell)/settings/workspace/actions";

const OTHER_SLUG = "ws-settings-other";

/** A complete, valid payload; each test overrides only what it exercises. */
const VALID: WorkspaceSettingsInput = {
  name: "Amara Beauty Ltd",
  timezone: "Africa/Kampala",
  alertEmail: "ops@amara.test",
  deadStockWindowDays: "45",
  methodA: "balanced",
  methodB: "lean_cash",
  methodC: "stay_in_stock",
};

describe.skipIf(!runnable)("saveWorkspaceSettings (local db)", () => {
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    const seed = await seedDev();
    tenantA = seed.tenantId;
    await prismaService.tenant.deleteMany({ where: { slug: OTHER_SLUG } });
    const other = await prismaService.tenant.create({
      data: { name: "Other Shop", slug: OTHER_SLUG },
    });
    tenantB = other.id;
  }, 120_000);

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: OTHER_SLUG } });
    // Put the shared dev tenant back the way the seed left it, so a later suite
    // that reads it without re-seeding still sees the seeded shape.
    await prismaService.tenantConfig.deleteMany({ where: { tenantId: tenantA } });
    await prismaService.tenant.update({
      where: { id: tenantA },
      data: { name: DEV_TENANT_NAME, timezone: "Africa/Nairobi" },
    });
    await prismaService.$disconnect();
  });

  function actAs(tenantId: string, permissions: unknown) {
    authState.session = { user: { id: "user-1", name: "Owner One", email: "owner@example.test" } };
    authState.membership = { tenantId, displayName: "Owner One", role: "OWNER", permissions };
  }

  const tenantRow = (id: string) =>
    prismaService.tenant.findUnique({
      where: { id },
      select: { name: true, timezone: true },
    });

  const configRow = (tenantId: string) =>
    prismaService.tenantConfig.findUnique({ where: { tenantId } });

  it("reads a workspace with no config row as all defaults", async () => {
    // The seed creates no TenantConfig, so this is the real new-tenant shape.
    expect(await configRow(tenantB)).toBeNull();

    const metrics = await getTodayMetrics(tenantB, { canViewCosts: true });
    expect(metrics.deadStock.windowDays).toBe(DEFAULT_DEAD_STOCK_DAYS);

    const knobs = resolveForecastKnobs(await configRow(tenantB));
    expect(knobs.methods).toEqual(METHOD_DEFAULTS);
  });

  it("creates the row on first save and every field reads back", async () => {
    expect(await configRow(tenantA)).toBeNull();
    actAs(tenantA, null); // OWNER preset includes manage_settings

    expect(await saveWorkspaceSettings(VALID)).toEqual({ ok: true });

    expect(await tenantRow(tenantA)).toEqual({
      name: "Amara Beauty Ltd",
      timezone: "Africa/Kampala",
    });
    const config = await configRow(tenantA);
    expect(config).toMatchObject({
      alertEmail: "ops@amara.test",
      deadStockWindowDays: 45,
      methodA: "balanced",
      methodB: "lean_cash",
      methodC: "stay_in_stock",
    });

    // The consumers pick the saved values up, not just the table.
    const metrics = await getTodayMetrics(tenantA, { canViewCosts: true });
    expect(metrics.deadStock.windowDays).toBe(45);
    expect(resolveForecastKnobs(config).methods).toEqual({
      A: "balanced",
      B: "lean_cash",
      C: "stay_in_stock",
    });

    const audits = await prismaService.auditEvent.findMany({
      where: { tenantId: tenantA, entity: "Tenant", action: "settings_updated" },
    });
    expect(audits).toHaveLength(1);
  });

  it("clears the optional fields back to their defaults", async () => {
    actAs(tenantA, null);
    expect(
      await saveWorkspaceSettings({ ...VALID, alertEmail: "", deadStockWindowDays: "" }),
    ).toEqual({ ok: true });

    const config = await configRow(tenantA);
    expect(config?.alertEmail).toBeNull();
    expect(config?.deadStockWindowDays).toBeNull();
    // A cleared window falls back to the code default, not to zero days.
    const metrics = await getTodayMetrics(tenantA, { canViewCosts: true });
    expect(metrics.deadStock.windowDays).toBe(DEFAULT_DEAD_STOCK_DAYS);
  });

  it("refuses a member without manage_settings, in the action", async () => {
    const before = await tenantRow(tenantA);
    actAs(tenantA, []); // explicit empty override — no permissions

    const result = await saveWorkspaceSettings({ ...VALID, name: "Hijacked" });
    expect(result).toEqual({ ok: false, error: "You don't have settings access." });
    expect(await tenantRow(tenantA)).toEqual(before);
  });

  it("writes only the caller's own workspace", async () => {
    const beforeA = await tenantRow(tenantA);
    const beforeConfigA = await configRow(tenantA);
    actAs(tenantB, null);

    expect(
      await saveWorkspaceSettings({ ...VALID, name: "Other Shop Renamed", alertEmail: "b@other.test" }),
    ).toEqual({ ok: true });

    expect((await tenantRow(tenantB))?.name).toBe("Other Shop Renamed");
    expect((await configRow(tenantB))?.alertEmail).toBe("b@other.test");
    // A is untouched — the action takes no tenant id, so there is nothing to spoof.
    expect(await tenantRow(tenantA)).toEqual(beforeA);
    expect(await configRow(tenantA)).toEqual(beforeConfigA);
  });

  it("rejects bad input without writing anything", async () => {
    actAs(tenantA, null);
    const before = await tenantRow(tenantA);
    const beforeConfig = await configRow(tenantA);

    const cases: { input: WorkspaceSettingsInput; field: string }[] = [
      { input: { ...VALID, name: "  " }, field: "name" },
      { input: { ...VALID, timezone: "Mars/Olympus" }, field: "timezone" },
      { input: { ...VALID, alertEmail: "not-an-email" }, field: "alertEmail" },
      { input: { ...VALID, deadStockWindowDays: "2" }, field: "deadStockWindowDays" },
      { input: { ...VALID, deadStockWindowDays: "9.5" }, field: "deadStockWindowDays" },
      { input: { ...VALID, methodB: "guesswork" }, field: "methods" },
    ];

    for (const { input, field } of cases) {
      const result = await saveWorkspaceSettings(input);
      expect(result.ok, `${field} should be rejected`).toBe(false);
      expect(result.ok === false && result.field).toBe(field);
    }

    expect(await tenantRow(tenantA)).toEqual(before);
    expect(await configRow(tenantA)).toEqual(beforeConfig);
  });

  it("refuses a caller with no workspace", async () => {
    authState.session = { user: { id: "user-1", name: "Nobody", email: "nobody@example.test" } };
    authState.membership = null;
    expect(await saveWorkspaceSettings(VALID)).toEqual({
      ok: false,
      error: "You're not in a workspace.",
    });
  });
});
