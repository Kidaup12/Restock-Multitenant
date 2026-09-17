import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Feature access from the operator console — the two knobs finer than the tier.
 *
 * setTenantFeatureOverride grants/denies a PLAN feature over the tier
 * (Tenant.featureOverrides); setTenantFeatureFlag flips a tenant SWITCH
 * (TenantConfig.featureFlags). The gate and the step-up grant are proven on
 * their own suites and stubbed open here, so what these tests hold is the part
 * that is new: what reaches each column, and what reaches the ledger.
 */

const dbUrl = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(dbUrl);

const ADMIN = {
  userId: "admin-feature-user",
  email: "feature-admin@example.test",
  name: "Feature Admin",
  sessionId: "sess-test",
  viaFallback: false,
};

vi.mock("@/lib/admin/gate", () => ({ requireAdmin: async () => ADMIN }));
vi.mock("@/lib/admin/step-up", () => ({ hasStepUp: async () => true }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { prismaService } from "@wezesha/db";
import { parseFeatureOverrides } from "@/lib/capabilities/plan-features";
import { featureEnabled } from "@/lib/capabilities/feature-flags";
import { setTenantFeatureFlag, setTenantFeatureOverride } from "@/app/admin/actions";

const SLUG = "admin-feature-tenant";

function form(entries: Record<string, string>): FormData {
  const body = new FormData();
  for (const [k, v] of Object.entries(entries)) body.set(k, v);
  return body;
}

describe.skipIf(!runnable)("admin feature access (local db)", () => {
  let tenantId = "";

  beforeAll(async () => {
    await cleanup();
    const tenant = await prismaService.tenant.create({
      data: { name: "Admin Feature Tenant", slug: SLUG, plan: "starter" },
    });
    tenantId = tenant.id;
  }, 60_000);

  afterAll(cleanup);

  async function cleanup() {
    const existing = await prismaService.tenant.findUnique({ where: { slug: SLUG } });
    if (existing) {
      await prismaService.auditEvent.deleteMany({ where: { tenantId: existing.id } });
      await prismaService.tenant.delete({ where: { id: existing.id } });
    }
  }

  const overridesNow = async () =>
    parseFeatureOverrides(
      (
        await prismaService.tenant.findUnique({
          where: { id: tenantId },
          select: { featureOverrides: true },
        })
      )?.featureOverrides
    );

  it("grants a feature, merges into the blob, and records who did it", async () => {
    expect(await setTenantFeatureOverride(form({ tenantId, feature: "transfers", value: "grant" }))).toEqual(
      { ok: true, feature: "transfers", value: "grant" }
    );
    expect(await overridesNow()).toEqual({ transfers: "grant" });

    // A second, different feature is merged, not overwritten.
    await setTenantFeatureOverride(form({ tenantId, feature: "team_depth", value: "deny" }));
    expect(await overridesNow()).toEqual({ transfers: "grant", team_depth: "deny" });

    const events = await prismaService.auditEvent.findMany({
      where: { tenantId, action: "feature_override_changed" },
      orderBy: { createdAt: "asc" },
    });
    expect(events.length).toBe(2);
    expect(events[0]!.entity).toBe("Tenant");
    expect(events[0]!.actorUserId).toBe(ADMIN.userId);
    expect(events[0]!.meta).toMatchObject({ feature: "transfers", from: "inherit", to: "grant" });
  });

  it("inherit removes just that key, and clearing the last one leaves SQL NULL", async () => {
    await setTenantFeatureOverride(form({ tenantId, feature: "transfers", value: "inherit" }));
    expect(await overridesNow()).toEqual({ team_depth: "deny" });

    await setTenantFeatureOverride(form({ tenantId, feature: "team_depth", value: "inherit" }));
    expect(await overridesNow()).toEqual({});
    const raw = await prismaService.tenant.findUnique({
      where: { id: tenantId },
      select: { featureOverrides: true },
    });
    expect(raw?.featureOverrides).toBeNull();
  });

  it("refuses an unknown feature or value, writing nothing", async () => {
    expect(await setTenantFeatureOverride(form({ tenantId, feature: "nope", value: "grant" }))).toEqual({
      ok: false,
      error: "Unknown feature.",
    });
    expect(await setTenantFeatureOverride(form({ tenantId, feature: "transfers", value: "maybe" }))).toEqual({
      ok: false,
      error: "Pick grant, deny, or inherit.",
    });
    expect(await overridesNow()).toEqual({});
  });

  it("flips a tenant switch off, creating the config row, and audits it", async () => {
    // Defaults on; turning it off is a real change and must persist.
    expect(await setTenantFeatureFlag(form({ tenantId, feature: "transfers", enabled: "false" }))).toEqual(
      { ok: true, feature: "transfers", enabled: false }
    );
    const config = await prismaService.tenantConfig.findUnique({ where: { tenantId } });
    expect(featureEnabled(config, "transfers")).toBe(false);

    const events = await prismaService.auditEvent.findMany({
      where: { tenantId, action: "feature_override_changed" },
    });
    // The switch flip shares the audit action; its meta names the switch.
    expect(events.some((e) => (e.meta as Record<string, unknown>)?.switch === "transfers")).toBe(true);
  });

  it("treats flipping a switch to its current effective value as a no-op", async () => {
    // weekly_digest defaults OFF; setting it false again should change nothing.
    const before = await prismaService.auditEvent.count({
      where: { tenantId, action: "feature_override_changed" },
    });
    expect(await setTenantFeatureFlag(form({ tenantId, feature: "weekly_digest", enabled: "false" }))).toEqual(
      { ok: true, feature: "weekly_digest", enabled: false }
    );
    const after = await prismaService.auditEvent.count({
      where: { tenantId, action: "feature_override_changed" },
    });
    expect(after).toBe(before);
  });

  it("404s on a workspace that does not exist", async () => {
    await expect(
      setTenantFeatureOverride(form({ tenantId: "no-such-id", feature: "transfers", value: "grant" }))
    ).rejects.toThrow();
    await expect(
      setTenantFeatureFlag(form({ tenantId: "no-such-id", feature: "transfers", enabled: "false" }))
    ).rejects.toThrow();
  });
});
