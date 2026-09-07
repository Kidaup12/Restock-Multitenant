import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * What the gate does when the write goes wrong.
 *
 * The gate covers the viewport and has no dismiss, so a failure here is not a
 * degraded screen — it is a locked door. It shipped without any handling: the
 * action could throw (an update the tenant scope cannot see, a ledger insert, a
 * dropped connection) and the only branch was `result.ok`, which never runs on a
 * rejected promise. The button returned to idle, nothing was said to the person,
 * and nothing was written anywhere a maintainer could read it — which is exactly
 * the shape of a report that reached us from production: accepted, still asked.
 *
 * These hold the two halves of that: a failure must come back as a RESULT rather
 * than a rejection, and it must leave a trace.
 */

const dbUrl = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(dbUrl);

const SLUG = "terms-failure-test";
const EMAIL = "terms-failure@example.test";
const USER_ID = "terms-failure-test-user";

const state = vi.hoisted(() => ({
  membership: null as null | { id: string; tenantId: string; displayName: string | null },
}));

vi.mock("@/lib/auth", () => ({
  requireSession: async () => ({
    user: { id: USER_ID, name: "Terms Failure", email: EMAIL },
  }),
  activeMembership: async () => state.membership,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { prismaService } from "@wezesha/db";
import { acceptTermsAction } from "@/app/(shell)/settings/terms-actions";
import { TERMS_VERSION } from "@/lib/legal";

describe.skipIf(!runnable)("the terms gate's failure path (local db)", () => {
  let tenantId: string;
  let membershipId: string;

  beforeAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    await prismaService.user.deleteMany({ where: { email: EMAIL } });
    const tenant = await prismaService.tenant.create({
      data: { name: "Terms Failure Co", slug: SLUG },
    });
    // User.id has no default in the schema — Better Auth supplies it.
    const user = await prismaService.user.create({
      data: { id: USER_ID, email: EMAIL, name: "Terms Failure" },
    });
    const membership = await prismaService.membership.create({
      data: { tenantId: tenant.id, userId: user.id, role: "OWNER" },
    });
    tenantId = tenant.id;
    membershipId = membership.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { id: tenantId } });
    await prismaService.user.deleteMany({ where: { email: EMAIL } });
    await prismaService.$disconnect();
  });

  it("answers a person rather than rejecting when the stamp cannot be written", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    // A membership id the tenant scope cannot resolve: the real update throws,
    // which is what used to escape as an unhandled rejection.
    state.membership = { id: "no-such-membership", tenantId, displayName: null };

    const result = await acceptTermsAction();

    expect(result.ok, "the gate went silent instead of answering").toBe(false);
    if (!result.ok) expect(result.error).toMatch(/try again/i);
    expect(logged, "the failure left no trace to diagnose from").toHaveBeenCalled();
  });

  it("says so plainly when there is no workspace to accept for", async () => {
    state.membership = null;
    const result = await acceptTermsAction();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/workspace/i);
  });

  it("stands the acceptance even if the ledger write fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(prismaService.auditEvent, "create").mockRejectedValueOnce(new Error("ledger down"));
    state.membership = { id: membershipId, tenantId, displayName: null };

    const result = await acceptTermsAction();

    // The stamp is what the gate reads. Sending someone back to a modal they
    // have just cleared because an audit row failed is the worse outcome.
    expect(result.ok, "a ledger failure locked the person out").toBe(true);
    expect(logged, "the ledger failure was swallowed silently").toHaveBeenCalled();

    const row = await prismaService.membership.findUniqueOrThrow({
      where: { id: membershipId },
      select: { acceptedTermsAt: true, acceptedTermsVersion: true },
    });
    expect(row.acceptedTermsVersion).toBe(TERMS_VERSION);
    expect(row.acceptedTermsAt).not.toBeNull();
  });
});
