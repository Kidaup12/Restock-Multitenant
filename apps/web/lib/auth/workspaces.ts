import { randomUUID } from "node:crypto";
import { Prisma, prismaForTenantTx } from "@wezesha/db";
import { listMemberships } from "@/lib/auth";

/**
 * First-run workspace creation — the only path in the product that mints a
 * Tenant. Everything else assumes a tenant already exists, so this is the one
 * operation that runs before any tenant scope does.
 *
 * It still runs on the RLS-ENFORCED client: the tenant id is generated up front
 * and used as the `app.tenant_id` GUC, so the whole thing is one transaction and
 * the Membership insert is checked by the database's WITH CHECK exactly like
 * every other tenant write. No BYPASSRLS service connection is needed, and the
 * pattern stays correct if the Tenant table ever gains an `id = app.tenant_id`
 * policy of its own.
 *
 * TenantConfig is deliberately not seeded: every reader treats a missing row as
 * "all defaults" (lib/data/today.ts, lib/capabilities, lib/limits/evaluate.ts,
 * packages/pos falls back to the tenant's own slug), so an all-null row would
 * be state that means nothing.
 */

export const WORKSPACE_NAME_MAX = 60;

const SLUG_MAX = 40;

/** How many `-2`, `-3`, … suffixes to try before the name is a lost cause. */
const SLUG_ATTEMPTS = 25;

/** URL-safe base for Tenant.slug — it is unique, and the POS feed falls back to
 *  it when TenantConfig.posFeedSlug is unset. */
export function workspaceSlug(name: string): string {
  const base = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, SLUG_MAX)
    .replace(/^-+|-+$/g, "");
  return base || "workspace";
}

export type CreateWorkspaceResult =
  | { ok: true; tenantId: string; slug: string; created: boolean }
  | { ok: false; error: string };

/** Unique-violation on Tenant.slug — the only P2002 this transaction can raise
 *  (the membership's (userId, tenantId) pair is fresh by construction). */
function slugTaken(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002" &&
    JSON.stringify(error.meta?.target ?? "").includes("slug")
  );
}

/**
 * Create a workspace and make the caller its OWNER. Idempotent by (owner, name):
 * re-submitting the same name returns the workspace the user already owns rather
 * than minting a second one, so a double-clicked form is harmless.
 */
export async function createWorkspace(input: {
  userId: string;
  name: string;
}): Promise<CreateWorkspaceResult> {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (name.length < 2) {
    return { ok: false, error: "Give the workspace a name (at least 2 characters)." };
  }
  if (name.length > WORKSPACE_NAME_MAX) {
    return { ok: false, error: `Keep the name under ${WORKSPACE_NAME_MAX} characters.` };
  }

  const owned = (await listMemberships(input.userId)).find(
    (m) => m.role === "OWNER" && m.tenant.name.toLowerCase() === name.toLowerCase(),
  );
  if (owned) {
    return { ok: true, tenantId: owned.tenantId, slug: owned.tenant.slug, created: false };
  }

  const base = workspaceSlug(name);
  for (let attempt = 1; attempt <= SLUG_ATTEMPTS; attempt++) {
    const slug = attempt === 1 ? base : `${base}-${attempt}`;
    const tenantId = randomUUID();
    try {
      await prismaForTenantTx(tenantId, async (tx) => {
        await tx.tenant.create({ data: { id: tenantId, name, slug } });
        await tx.membership.create({
          data: { userId: input.userId, tenantId, role: "OWNER" },
        });
      });
      return { ok: true, tenantId, slug, created: true };
    } catch (error) {
      if (!slugTaken(error)) throw error;
    }
  }
  return { ok: false, error: "That name is taken. Try a different one." };
}
