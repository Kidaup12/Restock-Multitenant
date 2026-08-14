import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Closing a workspace visit in the ledger.
 *
 * `impersonation_start` has always been written; the closing row only ever
 * existed for an admin who clicked Leave. Every other way out — signing out, or
 * entering a second workspace on top of the first — dropped the grant silently,
 * so the production ledger held starts with nothing to say when the operator
 * stopped being inside a customer's data.
 *
 * Expiry is the one ending nobody performs, and is deliberately NOT written
 * here: the cookie's maxAge is the grant's own TTL, so an expired grant is gone
 * from the browser and there is no later request to notice it in. What bounds it
 * is the start row's `meta.expiresAt` — the last test holds that.
 *
 * next/headers is an in-memory jar (no request scope) and the gate is stubbed —
 * both are proven on their own suites. The cookie signing, the ledger writes and
 * the tenant rows are the real thing against the local database.
 */

const jar = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      jar.store.has(name) ? { name, value: jar.store.get(name)! } : undefined,
    set: (name: string, value: string) => {
      if (value === "") jar.store.delete(name);
      else jar.store.set(name, value);
    },
  }),
}));

// Both throw in the real runtime; the sentinels let a test assert what a void
// action did on its way out.
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const ADMIN = {
  userId: "admin-exit-user",
  email: "exit-admin@example.test",
  name: "Exit Admin",
  sessionId: "sess-exit-test",
  viaFallback: false,
};

vi.mock("@/lib/admin/gate", () => ({
  requireAdmin: async () => ADMIN,
  isPlatformAdmin: async () => true,
}));
vi.mock("@/lib/admin/step-up", () => ({
  hasStepUp: async () => true,
  clearStepUpCookie: async () => {},
}));

import { prismaService } from "@wezesha/db";
import { enterWorkspace, exitWorkspace } from "@/app/admin/actions";
import { clearAdminCookies } from "@/app/admin/sign-out-actions";
import {
  ADMIN_TENANT_COOKIE,
  ADMIN_TENANT_TTL_MS,
  signAdminTenant,
} from "@/lib/admin/impersonation";

const dbUrl = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(dbUrl);

const SLUG_A = "admin-exit-a";
const SLUG_B = "admin-exit-b";

/** Run a void action that ends in redirect(), and hand back where it went. */
async function following(action: () => Promise<void>): Promise<string> {
  try {
    await action();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("NEXT_REDIRECT:")) return message.slice("NEXT_REDIRECT:".length);
    throw err;
  }
  throw new Error("expected the action to redirect");
}

describe.skipIf(!runnable)("closing an admin workspace visit (local db)", () => {
  let tenantAId = "";
  let tenantBId = "";

  beforeAll(async () => {
    await cleanup();
    const a = await prismaService.tenant.create({ data: { name: "Admin Exit A", slug: SLUG_A } });
    const b = await prismaService.tenant.create({ data: { name: "Admin Exit B", slug: SLUG_B } });
    tenantAId = a.id;
    tenantBId = b.id;
  }, 60_000);

  afterAll(cleanup);

  beforeEach(async () => {
    jar.store.clear();
    await prismaService.auditEvent.deleteMany({
      where: { tenantId: { in: [tenantAId, tenantBId].filter(Boolean) } },
    });
  });

  async function cleanup() {
    const existing = await prismaService.tenant.findMany({
      where: { slug: { in: [SLUG_A, SLUG_B] } },
      select: { id: true },
    });
    const ids = existing.map((t) => t.id);
    if (ids.length === 0) return;
    await prismaService.auditEvent.deleteMany({ where: { tenantId: { in: ids } } });
    await prismaService.tenant.deleteMany({ where: { id: { in: ids } } });
  }

  const visitEvents = (tenantId: string) =>
    prismaService.auditEvent.findMany({
      where: { tenantId, action: { in: ["impersonation_start", "impersonation_end"] } },
      orderBy: { createdAt: "asc" },
    });

  const countOf = async (tenantId: string, action: string) =>
    (await visitEvents(tenantId)).filter((e) => e.action === action).length;

  /** Enter a workspace the way the console does: the form action. */
  async function enter(tenantId: string): Promise<void> {
    const body = new FormData();
    body.set("tenantId", tenantId);
    expect(await following(() => enterWorkspace(body))).toBe(`/admin/tenant/${tenantId}`);
  }

  it("signing out of an open visit closes it in the ledger", async () => {
    await enter(tenantAId);
    expect(await countOf(tenantAId, "impersonation_start")).toBe(1);

    await clearAdminCookies();

    // The gap this suite exists for: the grant is gone from the browser, so
    // "when did the operator leave" has to be answerable from the ledger alone.
    const ends = (await visitEvents(tenantAId)).filter((e) => e.action === "impersonation_end");
    expect(ends).toHaveLength(1);
    expect(ends[0]!.actorUserId).toBe(ADMIN.userId);
    expect(ends[0]!.meta).toMatchObject({ reason: "sign_out", adminEmail: ADMIN.email });
    expect(jar.store.has(ADMIN_TENANT_COOKIE)).toBe(false);
  });

  it("a visit that is still open has NO end row", async () => {
    // The control that makes the one above mean something: "always write an end"
    // would pass that test and be wrong here.
    await enter(tenantAId);

    expect(await countOf(tenantAId, "impersonation_start")).toBe(1);
    expect(await countOf(tenantAId, "impersonation_end")).toBe(0);
    expect(jar.store.has(ADMIN_TENANT_COOKIE)).toBe(true);
  });

  it("signing out with no visit open writes nothing", async () => {
    await clearAdminCookies();
    expect(await visitEvents(tenantAId)).toHaveLength(0);
    expect(await visitEvents(tenantBId)).toHaveLength(0);
  });

  it("clicking Leave writes exactly one end row and drops the grant", async () => {
    await enter(tenantAId);
    expect(await following(() => exitWorkspace())).toBe("/admin");

    const ends = (await visitEvents(tenantAId)).filter((e) => e.action === "impersonation_end");
    expect(ends).toHaveLength(1);
    expect(ends[0]!.entity).toBe("AdminSession");
    expect(ends[0]!.meta).toMatchObject({ reason: "exit" });
    expect(jar.store.has(ADMIN_TENANT_COOKIE)).toBe(false);

    // Leaving twice must not invent a second departure.
    expect(await following(() => exitWorkspace())).toBe("/admin");
    expect(await countOf(tenantAId, "impersonation_end")).toBe(1);
  });

  it("entering a second workspace closes the one still open", async () => {
    // The third exit path: entering re-signs the cookie, so the first visit ends
    // at that instant with no click and no sign-out to record it.
    await enter(tenantAId);
    await enter(tenantBId);

    const endsA = (await visitEvents(tenantAId)).filter((e) => e.action === "impersonation_end");
    expect(endsA).toHaveLength(1);
    expect(endsA[0]!.meta).toMatchObject({ reason: "superseded" });

    // B is the visit that is now open — it must not have been closed too.
    expect(await countOf(tenantBId, "impersonation_start")).toBe(1);
    expect(await countOf(tenantBId, "impersonation_end")).toBe(0);
  });

  it("re-entering the same workspace closes the grant it replaced", async () => {
    // Every entry mints a fresh start row, so a re-entry that wrote no end would
    // leave the ledger reading two visits deep into one workspace.
    await enter(tenantAId);
    await enter(tenantAId);

    expect(await countOf(tenantAId, "impersonation_start")).toBe(2);
    expect(await countOf(tenantAId, "impersonation_end")).toBe(1);
  });

  it("an expired grant writes no end row, and its start row says when it lapsed", async () => {
    // Expiry is not something anyone does, so there is no request to write it
    // in — and the cookie is gone by then anyway. The honest record is the
    // bound already on the start row, not a row timestamped whenever we next
    // happened to look.
    await enter(tenantAId);
    const [start] = await visitEvents(tenantAId);
    const expiresAt = Date.parse((start!.meta as { expiresAt: string }).expiresAt);
    expect(expiresAt).toBeGreaterThan(start!.createdAt.getTime());
    expect(expiresAt - start!.createdAt.getTime()).toBeLessThanOrEqual(ADMIN_TENANT_TTL_MS + 5_000);

    // A grant that lapsed rather than being left: signing out finds nothing live.
    jar.store.set(ADMIN_TENANT_COOKIE, signAdminTenant(tenantAId, Date.now() - ADMIN_TENANT_TTL_MS - 1));
    await clearAdminCookies();

    expect(await countOf(tenantAId, "impersonation_end")).toBe(0);
    expect(jar.store.has(ADMIN_TENANT_COOKIE)).toBe(false);
  });
});
