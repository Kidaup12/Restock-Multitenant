import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Offboarding a workspace from the operator console.
 *
 * The guards ARE the feature here. Deletion cascades across every table and no
 * restore has ever been rehearsed against the hosted database, so the export is
 * the recovery plan — and `deleteTenant` refuses without a fresh one. These
 * tests prove an admin who skips the export, or mistypes the slug, destroys
 * nothing, and that a platform admin can offboard a workspace they are NOT a
 * member of (the gap that previously forced a hand-written Membership row).
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const adminState = vi.hoisted(() => ({
  actor: {
    userId: "offboard-admin",
    sessionId: "session-1",
    email: "ops@wezesha.test",
    name: "Operator",
    viaFallback: false,
  },
  stepUp: true,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: () => {},
}));
vi.mock("@/lib/admin/gate", async () => {
  const actual = await vi.importActual<typeof import("@/lib/admin/gate")>("@/lib/admin/gate");
  return { ...actual, requireAdmin: async () => adminState.actor };
});
vi.mock("@/lib/admin/step-up", async () => {
  const actual = await vi.importActual<typeof import("@/lib/admin/step-up")>("@/lib/admin/step-up");
  return { ...actual, hasStepUp: async () => adminState.stepUp };
});

import { prismaService } from "@wezesha/db";
import { deleteWorkspaceAction, exportWorkspaceAction } from "../app/admin/actions";
import { STEP_UP_REQUIRED } from "@/lib/admin/step-up-contract";

const SLUG = "offboard-target";

describe.skipIf(!runnable)("operator offboarding (local db)", () => {
  let tenantId: string;

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    await prismaService.$disconnect();
  });

  beforeEach(async () => {
    adminState.stepUp = true;
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    const tenant = await prismaService.tenant.create({
      data: { name: "Offboard Target", slug: SLUG, currency: "KES" },
    });
    tenantId = tenant.id;
    await prismaService.product.create({
      data: { tenantId, sku: "OFF-1", title: "Doomed", vendor: "House" },
    });
    // The admin is deliberately NOT a member of this workspace.
    await prismaService.auditEvent.deleteMany({ where: { tenantId } });
  });

  const form = (entries: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(entries)) f.set(k, v);
    return f;
  };

  const tenantStillThere = async () =>
    (await prismaService.tenant.findUnique({ where: { id: tenantId } })) !== null;

  it("refuses to delete without a fresh export, even with the slug typed correctly", async () => {
    const result = await deleteWorkspaceAction(form({ tenantId, confirmSlug: SLUG }));
    expect(result.ok).toBe(false);
    expect(await tenantStillThere()).toBe(true);
    await expect(prismaService.product.count({ where: { tenantId } })).resolves.toBe(1);
  });

  it("refuses when the typed slug does not match, even after an export", async () => {
    await exportWorkspaceAction(form({ tenantId }));
    const result = await deleteWorkspaceAction(form({ tenantId, confirmSlug: "not-the-slug" }));
    expect(result.ok).toBe(false);
    expect(await tenantStillThere()).toBe(true);
  });

  it("refuses both actions without step-up", async () => {
    adminState.stepUp = false;
    expect(await exportWorkspaceAction(form({ tenantId }))).toEqual({
      ok: false,
      error: STEP_UP_REQUIRED,
    });
    expect(await deleteWorkspaceAction(form({ tenantId, confirmSlug: SLUG }))).toEqual({
      ok: false,
      error: STEP_UP_REQUIRED,
    });
    expect(await tenantStillThere()).toBe(true);
  });

  it("exports the workspace and records the row that unlocks deletion", async () => {
    const result = await exportWorkspaceAction(form({ tenantId }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.filename).toContain(SLUG);
    expect(JSON.parse(result.json)).toBeTypeOf("object");

    const exported = await prismaService.auditEvent.findFirst({
      where: { tenantId, entity: "Tenant", action: "exported" },
    });
    expect(exported).not.toBeNull();
    expect(exported!.actorUserId).toBe(adminState.actor.userId);
  });

  it("deletes a workspace the admin is not a member of, once exported and confirmed", async () => {
    await exportWorkspaceAction(form({ tenantId }));
    const result = await deleteWorkspaceAction(form({ tenantId, confirmSlug: SLUG }));
    expect(result).toEqual({ ok: true });

    expect(await tenantStillThere()).toBe(false);
    expect(await prismaService.product.count({ where: { tenantId } })).toBe(0);

    // The obituary outlives the cascade — it carries no foreign key on purpose.
    const obituary = await prismaService.auditEvent.findFirst({
      where: { tenantId, entity: "Tenant", action: "deleted" },
    });
    expect(obituary).not.toBeNull();
  });
});
