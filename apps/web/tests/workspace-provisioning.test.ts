import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_PLAN, prismaService } from "@wezesha/db";
import { createWorkspace, workspaceSlug, WORKSPACE_NAME_MAX } from "../lib/auth/workspaces";

/**
 * First-run workspace creation against the local database. This is the only
 * path that mints a Tenant, and it runs before any tenant scope exists, so the
 * cases that matter are: the creator really owns it, two workspaces never share
 * a slug, a double-submit doesn't mint a second one, and the new tenant sees
 * nothing of anyone else's. Skips when no local database is configured.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const EMAILS = ["ws-prov-owner@example.test", "ws-prov-other@example.test"];
/** Every workspace this suite creates derives its slug from this prefix. */
const NAME_PREFIX = "Ws Prov";

async function cleanup(): Promise<void> {
  await prismaService.tenant.deleteMany({ where: { slug: { startsWith: workspaceSlug(NAME_PREFIX) } } });
  await prismaService.user.deleteMany({ where: { email: { in: EMAILS } } });
}

describe.skipIf(!runnable)("createWorkspace (local db)", () => {
  let ownerId: string;
  let otherId: string;

  beforeAll(async () => {
    await cleanup();
    // Better Auth owns user ids, so there is no database default to lean on.
    const [owner, other] = await Promise.all([
      prismaService.user.create({
        data: { id: randomUUID(), email: EMAILS[0]!, name: "Prov Owner" },
      }),
      prismaService.user.create({
        data: { id: randomUUID(), email: EMAILS[1]!, name: "Prov Other" },
      }),
    ]);
    ownerId = owner.id;
    otherId = other.id;
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await prismaService.$disconnect();
  });

  it("makes the creator the OWNER of a real tenant", async () => {
    const result = await createWorkspace({ userId: ownerId, name: `${NAME_PREFIX} Alpha` });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);

    // Verified independently, not from the return value.
    const tenant = await prismaService.tenant.findUnique({ where: { id: result.tenantId } });
    expect(tenant?.name).toBe(`${NAME_PREFIX} Alpha`);
    expect(tenant?.slug).toBe(result.slug);

    const memberships = await prismaService.membership.findMany({
      where: { tenantId: result.tenantId },
    });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.userId).toBe(ownerId);
    expect(memberships[0]!.role).toBe("OWNER");
  });

  it("provisions the tenant with a stated plan and its settings row", async () => {
    const result = await createWorkspace({ userId: ownerId, name: `${NAME_PREFIX} Eta` });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The tier is written, not inferred: null would resolve to the same tier,
    // which is exactly why a silent null is easy to mistake for a decision.
    const tenant = await prismaService.tenant.findUnique({ where: { id: result.tenantId } });
    expect(tenant?.plan).toBe(DEFAULT_PLAN);

    // Exactly one config row, and it carries no invented settings — every
    // column stays null so the code defaults keep applying.
    const configs = await prismaService.tenantConfig.findMany({
      where: { tenantId: result.tenantId },
    });
    expect(configs).toHaveLength(1);
    expect(configs[0]!.alertEmail).toBeNull();
    expect(configs[0]!.posFeedSlug).toBeNull();
    expect(configs[0]!.notifyPrefs).toBeNull();
    expect(configs[0]!.featureFlags).toBeNull();
  });

  it("rolls the whole attempt back when the slug is already taken", async () => {
    const name = `${NAME_PREFIX} Theta`;
    // Occupy the first-choice slug so creation has to retry with a suffix.
    const squatter = await prismaService.tenant.create({
      data: { name: `${name} Squatter`, slug: workspaceSlug(name) },
    });

    const result = await createWorkspace({ userId: ownerId, name });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slug).not.toBe(workspaceSlug(name));
    expect(result.slug.startsWith(workspaceSlug(name))).toBe(true);

    // The abandoned attempt left nothing behind, and the squatter — created
    // outside this path — is untouched.
    expect(
      await prismaService.tenantConfig.count({ where: { tenantId: result.tenantId } }),
    ).toBe(1);
    expect(await prismaService.tenantConfig.count({ where: { tenantId: squatter.id } })).toBe(0);
  });

  it("gives two workspaces of the same name different slugs", async () => {
    const name = `${NAME_PREFIX} Beta`;
    const [mine, theirs] = [
      await createWorkspace({ userId: ownerId, name }),
      await createWorkspace({ userId: otherId, name }),
    ];
    expect(mine.ok && theirs.ok).toBe(true);
    if (!mine.ok || !theirs.ok) return;

    expect(theirs.tenantId).not.toBe(mine.tenantId);
    expect(theirs.slug).not.toBe(mine.slug);
    // Both derive from the same base; the second is suffixed, not mangled.
    expect(theirs.slug.startsWith(workspaceSlug(name))).toBe(true);
  });

  it("returns the existing workspace when the same owner submits twice", async () => {
    const name = `${NAME_PREFIX} Gamma`;
    const first = await createWorkspace({ userId: ownerId, name });
    const second = await createWorkspace({ userId: ownerId, name });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.tenantId).toBe(first.tenantId);
    expect(second.created).toBe(false);

    const owned = await prismaService.tenant.count({ where: { name } });
    expect(owned).toBe(1);
    // The second submit re-used the workspace rather than adding a config row.
    expect(
      await prismaService.tenantConfig.count({ where: { tenantId: first.tenantId } }),
    ).toBe(1);
  });

  it("survives a genuinely concurrent double submit", async () => {
    const name = `${NAME_PREFIX} Delta`;
    const [a, b] = await Promise.all([
      createWorkspace({ userId: ownerId, name }),
      createWorkspace({ userId: ownerId, name }),
    ]);
    expect(a.ok && b.ok).toBe(true);

    // The race may legitimately mint two tenants (neither call can see the
    // other's uncommitted row), but each must be a valid workspace the creator
    // owns — never a tenant with no owner, never a shared slug, and never one
    // missing or doubling its config row.
    const tenants = await prismaService.tenant.findMany({
      where: { name },
      select: { id: true, slug: true, plan: true },
    });
    expect(tenants.length).toBeGreaterThanOrEqual(1);
    expect(new Set(tenants.map((t) => t.slug)).size).toBe(tenants.length);
    for (const tenant of tenants) {
      const owners = await prismaService.membership.count({
        where: { tenantId: tenant.id, userId: ownerId, role: "OWNER" },
      });
      expect(owners).toBe(1);
      expect(tenant.plan).toBe(DEFAULT_PLAN);
      expect(await prismaService.tenantConfig.count({ where: { tenantId: tenant.id } })).toBe(1);
    }
  });

  it("starts empty and carries none of another workspace's rows", async () => {
    const mine = await createWorkspace({ userId: ownerId, name: `${NAME_PREFIX} Epsilon` });
    const theirs = await createWorkspace({ userId: otherId, name: `${NAME_PREFIX} Zeta` });
    expect(mine.ok && theirs.ok).toBe(true);
    if (!mine.ok || !theirs.ok) return;

    await prismaService.product.create({
      data: { tenantId: theirs.tenantId, sku: "WS-PROV-1", title: "Theirs", priceKes: 100, costKes: 60 },
    });

    const seenFromMine = await prismaService.product.count({ where: { tenantId: mine.tenantId } });
    expect(seenFromMine).toBe(0);
    // The creator is a member of their own workspace and of nobody else's.
    const cross = await prismaService.membership.count({
      where: { tenantId: theirs.tenantId, userId: ownerId },
    });
    expect(cross).toBe(0);
  });

  it("rejects a name that is blank or too long, without touching the database", async () => {
    const before = await prismaService.tenant.count();
    for (const name of ["", "   ", "a", "x".repeat(WORKSPACE_NAME_MAX + 1)]) {
      const result = await createWorkspace({ userId: ownerId, name });
      expect(result.ok).toBe(false);
    }
    expect(await prismaService.tenant.count()).toBe(before);
  });

  it("builds a URL-safe slug and never an empty one", () => {
    expect(workspaceSlug("Amara Beauty")).toBe("amara-beauty");
    expect(workspaceSlug("  Mixed --- Punctuation!  ")).toBe("mixed-punctuation");
    expect(workspaceSlug("////")).toBe("workspace");
  });
});
