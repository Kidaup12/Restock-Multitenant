import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  allowed: true,
  findUnique: vi.fn(async () => ({ baselineMethod: null, abcWindowDays: null })),
  upsert: vi.fn(async () => ({})),
  audit: vi.fn(async () => ({})),
  scoped: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@wezesha/db", () => ({
  prismaForTenant: (tenantId: string) => {
    mocks.scoped(tenantId);
    return { tenantConfig: { findUnique: mocks.findUnique, upsert: mocks.upsert } };
  },
  prismaService: { auditEvent: { create: mocks.audit } },
}));
vi.mock("@/lib/auth", () => ({
  requireSession: async () => ({ user: { id: "user", name: "Owner" } }),
  activeMembership: async () => ({ tenantId: "shop", displayName: "Owner" }),
}));
vi.mock("@/lib/auth/permissions", () => ({ hasPermission: () => mocks.allowed }));

import { saveForecastSettings } from "../app/(shell)/settings/ordering-strategy/actions";
import { parseForecastSettings } from "../app/(shell)/settings/ordering-strategy/forecast-settings";

beforeEach(() => { vi.clearAllMocks(); mocks.allowed = true; });

describe("forecast settings", () => {
  it.each([30, 60, 90])("accepts the original ABC window %i", (abcWindowDays) => {
    expect(parseForecastSettings({ baselineMethod: "median", abcWindowDays, bigBuyerDamping: false })).toEqual({ baselineMethod: "median", abcWindowDays, bigBuyerDamping: false });
  });
  it.each([null, {}, { baselineMethod: "other", abcWindowDays: 30, bigBuyerDamping: false }, { baselineMethod: "mean", abcWindowDays: 31, bigBuyerDamping: false }, { baselineMethod: "mean", abcWindowDays: "30", bigBuyerDamping: false }, { baselineMethod: "mean", abcWindowDays: 30, bigBuyerDamping: "true" }, { baselineMethod: "mean", abcWindowDays: 30 }])("rejects unsupported settings", (input) => {
    expect(parseForecastSettings(input)).toBeNull();
  });
  it("writes only the active tenant and records the change", async () => {
    expect(await saveForecastSettings({ baselineMethod: "median", abcWindowDays: 60, bigBuyerDamping: true, tenantId: "other" })).toEqual({ ok: true });
    expect(mocks.scoped).toHaveBeenCalledWith("shop");
    expect(mocks.upsert).toHaveBeenCalledWith({
      where: { tenantId: "shop" },
      create: { tenantId: "shop", baselineMethod: "median", abcWindowDays: 60, bigBuyerDamping: true },
      update: { baselineMethod: "median", abcWindowDays: 60, bigBuyerDamping: true },
    });
    expect(mocks.audit).toHaveBeenCalledWith({ data: expect.objectContaining({ tenantId: "shop", actorUserId: "user", action: "forecast_settings_changed" }) });
  });
  it("prevents unauthorized writes", async () => {
    mocks.allowed = false;
    expect((await saveForecastSettings({ baselineMethod: "mean", abcWindowDays: 90, bigBuyerDamping: true })).ok).toBe(false);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
  it("prevents invalid writes", async () => {
    expect((await saveForecastSettings({ baselineMethod: "median", abcWindowDays: 365, bigBuyerDamping: false })).ok).toBe(false);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});
