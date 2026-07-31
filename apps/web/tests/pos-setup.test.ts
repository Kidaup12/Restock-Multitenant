import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Turning a shop's till feed on from settings.
 *
 * The ingest endpoint, the matching queue and gap detection all existed; what
 * did not was any way to switch the feed on without an engineer running a
 * script. In this market most sales happen over the counter, so a workspace
 * that cannot connect its till has a forecast built on a minority of its trade.
 *
 * What these hold: the secret works end to end against the real authenticator,
 * rotation genuinely kills the old one, switching off closes the door, and one
 * workspace's feed name can never be claimed or shadowed by another.
 */

const dbUrl = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(dbUrl);

const authState: { session: { user: { id: string } }; membership: unknown } = {
  session: { user: { id: "pos-setup-user" } },
  membership: null,
};

vi.mock("@/lib/auth", () => ({
  requireSession: async () => authState.session,
  activeMembership: async () => authState.membership,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { prismaService } from "@wezesha/db";
import { authenticatePosFeed } from "@wezesha/pos";
import {
  disablePosIngest,
  rotatePosIngestSecret,
  setPosFeedSlug,
} from "@/app/(shell)/settings/pos/actions";

const SLUGS = ["pos-setup-a", "pos-setup-b"];

describe.skipIf(!runnable)("till feed setup (local db)", () => {
  let tenantA = "";
  let tenantB = "";

  const actAs = (tenantId: string, slug: string, permissions: string[] | null = null) => {
    authState.membership = {
      id: `m-${tenantId}`,
      tenantId,
      role: "OWNER",
      permissions,
      tenant: { slug, name: slug, currency: "KES" },
    };
  };

  beforeAll(async () => {
    await cleanup();
    const [a, b] = await Promise.all(
      SLUGS.map((slug) => prismaService.tenant.create({ data: { name: slug, slug, plan: "growth" } })),
    );
    tenantA = a!.id;
    tenantB = b!.id;
    await prismaService.tenantConfig.createMany({
      data: [{ tenantId: tenantA }, { tenantId: tenantB }],
    });
    actAs(tenantA, SLUGS[0]!);
  }, 60_000);

  afterAll(cleanup);

  async function cleanup() {
    const tenants = await prismaService.tenant.findMany({
      where: { slug: { in: [...SLUGS, "pos-setup-shadow"] } },
      select: { id: true },
    });
    const ids = tenants.map((t) => t.id);
    if (ids.length) {
      await prismaService.auditEvent.deleteMany({ where: { tenantId: { in: ids } } });
      await prismaService.tenantConfig.deleteMany({ where: { tenantId: { in: ids } } });
      await prismaService.tenant.deleteMany({ where: { id: { in: ids } } });
    }
  }

  it("mints a secret the real authenticator accepts", async () => {
    const result = await rotatePosIngestSecret();
    expect(result.ok).toBe(true);
    if (!result.ok || !result.secret) throw new Error("expected a secret");

    // End to end against the same function the ingest route calls — not a
    // re-implementation of the hash comparison.
    await expect(authenticatePosFeed(SLUGS[0]!, result.secret)).resolves.toEqual({ id: tenantA });
    await expect(authenticatePosFeed(SLUGS[0]!, "not-the-secret")).resolves.toBeNull();
  });

  it("stores only a fingerprint, never the secret", async () => {
    const result = await rotatePosIngestSecret();
    if (!result.ok || !result.secret) throw new Error("expected a secret");

    const config = await prismaService.tenantConfig.findUnique({ where: { tenantId: tenantA } });
    expect(config?.posIngestSecretHash).not.toBe(result.secret);
    expect(config?.posIngestSecretHash).toMatch(/^[0-9a-f]{64}$/);

    // Nor does the plaintext reach the ledger.
    const events = await prismaService.auditEvent.findMany({
      where: { tenantId: tenantA, action: "pos_secret_rotated" },
    });
    expect(JSON.stringify(events)).not.toContain(result.secret);
  });

  it("kills the previous secret the moment a new one is made", async () => {
    const first = await rotatePosIngestSecret();
    if (!first.ok || !first.secret) throw new Error("expected a secret");
    const second = await rotatePosIngestSecret();
    if (!second.ok || !second.secret) throw new Error("expected a secret");

    expect(second.secret).not.toBe(first.secret);
    await expect(authenticatePosFeed(SLUGS[0]!, first.secret)).resolves.toBeNull();
    await expect(authenticatePosFeed(SLUGS[0]!, second.secret)).resolves.toEqual({ id: tenantA });
  });

  it("closes ingest entirely when switched off", async () => {
    const minted = await rotatePosIngestSecret();
    if (!minted.ok || !minted.secret) throw new Error("expected a secret");

    expect((await disablePosIngest()).ok).toBe(true);
    // No fallback credential to inherit — the door is shut, not loosened.
    await expect(authenticatePosFeed(SLUGS[0]!, minted.secret)).resolves.toBeNull();
    expect(await disablePosIngest()).toEqual({
      ok: false,
      error: "Till sales are already switched off.",
    });
  });

  it("routes a custom feed name to the workspace that owns it", async () => {
    const minted = await rotatePosIngestSecret();
    if (!minted.ok || !minted.secret) throw new Error("expected a secret");
    expect((await setPosFeedSlug({ slug: "till-westlands" })).ok).toBe(true);

    await expect(authenticatePosFeed("till-westlands", minted.secret)).resolves.toEqual({
      id: tenantA,
    });
    // The workspace slug keeps working too — the resolver accepts either.
    await expect(authenticatePosFeed(SLUGS[0]!, minted.secret)).resolves.toEqual({ id: tenantA });
  });

  it("refuses a feed name another workspace already claimed", async () => {
    actAs(tenantB, SLUGS[1]!);
    expect(await setPosFeedSlug({ slug: "till-westlands" })).toEqual({
      ok: false,
      error: "That name is already in use. Pick another.",
    });
    actAs(tenantA, SLUGS[0]!);
  });

  it("refuses a feed name that would shadow another workspace's own slug", async () => {
    // Otherwise their till, posting under their own slug, would resolve to us
    // and stop working — a denial of service against a shop we never touch.
    actAs(tenantB, SLUGS[1]!);
    expect(await setPosFeedSlug({ slug: SLUGS[0]! })).toEqual({
      ok: false,
      error: "That name is already in use. Pick another.",
    });
    actAs(tenantA, SLUGS[0]!);
  });

  it("falls back to the workspace slug when the custom name is cleared", async () => {
    expect((await setPosFeedSlug({ slug: "" })).ok).toBe(true);
    const config = await prismaService.tenantConfig.findUnique({ where: { tenantId: tenantA } });
    expect(config?.posFeedSlug).toBeNull();
  });

  it("rejects a malformed feed name", async () => {
    for (const bad of ["Till Westlands", "a", "-leading", "way-too-long".repeat(6)]) {
      const result = await setPosFeedSlug({ slug: bad });
      expect(result.ok).toBe(false);
    }
  });

  it("refuses everything without settings access", async () => {
    actAs(tenantA, SLUGS[0]!, []); // membership with an explicit empty permission set
    const denied = "You don't have settings access in this workspace.";
    expect(await rotatePosIngestSecret()).toEqual({ ok: false, error: denied });
    expect(await disablePosIngest()).toEqual({ ok: false, error: denied });
    expect(await setPosFeedSlug({ slug: "sneaky" })).toEqual({ ok: false, error: denied });
    actAs(tenantA, SLUGS[0]!);
  });
});
