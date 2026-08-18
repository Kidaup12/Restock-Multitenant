import { prismaForTenant } from "@wezesha/db";
import { priorActive, OWNER_PRIOR_MAX_MULTIPLIER } from "@wezesha/forecast";

/**
 * Owner-prior write path — the "tell the forecast something" box (spec §6).
 * Priors are created, listed, and revoked (soft-delete) by the owner; the
 * forecast run reads the active ones and shows it listened. Single-tenant path:
 * all access goes through the RLS-enforced tenant client.
 */

export type OwnerPriorScope = "product" | "brand";

export type CreateOwnerPriorInput = {
  scope: OwnerPriorScope;
  /** productId (product scope) or brand/vendor name (brand scope). */
  scopeValue: string;
  /** "I expect about X units / 30 days". */
  expectedUnits?: number | null;
  /** Scale the current forecast by this factor. */
  multiplier?: number | null;
  /** Cold-start "sell like": the established product to borrow from. */
  proxyProductId?: string | null;
  /** How long the prior stays in force (weeks). Defaults to 4. */
  weeks?: number;
  note?: string | null;
  createdByUserId?: string | null;
  createdByName?: string | null;
};

export type OwnerPriorRecord = {
  id: string;
  scope: OwnerPriorScope;
  scopeValue: string;
  expectedUnits: number | null;
  multiplier: number | null;
  proxyProductId: string | null;
  weeks: number;
  note: string | null;
  createdByName: string | null;
  createdAt: Date;
  revokedAt: Date | null;
  /** Convenience: within its weeks window and not revoked, as of now. */
  active: boolean;
};

const DEFAULT_WEEKS = 4;

/** At least one expectation form must be supplied, or the prior says nothing. */
export function validateOwnerPriorInput(input: CreateOwnerPriorInput): string | null {
  if (input.scope !== "product" && input.scope !== "brand") return "scope must be product or brand";
  if (!input.scopeValue?.trim()) return "scopeValue is required";
  const hasExpectation =
    input.expectedUnits != null || input.multiplier != null || input.proxyProductId != null;
  if (!hasExpectation) {
    return "give the forecast something: an expected amount, a multiplier, or a product to sell like";
  }
  if (input.expectedUnits != null && input.expectedUnits < 0) return "expected units cannot be negative";
  if (input.multiplier != null && input.multiplier <= 0) return "multiplier must be greater than zero";
  if (input.multiplier != null && input.multiplier > OWNER_PRIOR_MAX_MULTIPLIER) {
    return `multiplier cannot exceed ${OWNER_PRIOR_MAX_MULTIPLIER}x — for a bigger change, set an expected amount instead`;
  }
  if (input.proxyProductId != null && input.scope !== "product") {
    return "a 'sell like' proxy only applies to a single product";
  }
  return null;
}

/**
 * A prior names products by id — the scope value on a product-scoped prior, and
 * the "sell like" proxy — and both ids arrive from the request body. OwnerPrior
 * has no foreign key on either, and RLS has nothing to filter on a create, so
 * the guard is a scoped READ: under RLS this can only see the caller's own
 * catalogue, and a foreign id resolves to nothing.
 */
async function namesOnlyOwnProducts(
  tenantId: string,
  input: CreateOwnerPriorInput
): Promise<boolean> {
  const named = new Set(
    [
      input.scope === "product" ? input.scopeValue.trim() : null,
      input.proxyProductId ?? null,
    ].filter((id): id is string => !!id)
  );
  if (named.size === 0) return true;
  const owned = await prismaForTenant(tenantId).product.findMany({
    where: { id: { in: [...named] } },
    select: { id: true },
  });
  return owned.length === named.size;
}

export async function createOwnerPrior(
  tenantId: string,
  input: CreateOwnerPriorInput
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const error = validateOwnerPriorInput(input);
  if (error) return { ok: false, error };
  if (!(await namesOnlyOwnProducts(tenantId, input))) {
    return { ok: false, error: "that product is not in this workspace" };
  }
  const created = await prismaForTenant(tenantId).ownerPrior.create({
    data: {
      tenantId,
      scope: input.scope,
      scopeValue: input.scopeValue.trim(),
      expectedUnits: input.expectedUnits ?? null,
      multiplier: input.multiplier ?? null,
      proxyProductId: input.proxyProductId ?? null,
      weeks: input.weeks ?? DEFAULT_WEEKS,
      note: input.note ?? null,
      createdByUserId: input.createdByUserId ?? null,
      createdByName: input.createdByName ?? null,
    },
    select: { id: true },
  });
  return { ok: true, id: created.id };
}

/** Soft-delete a prior — still listed, no longer applied. False = not found or
 *  already revoked. */
export async function revokeOwnerPrior(tenantId: string, id: string): Promise<boolean> {
  const res = await prismaForTenant(tenantId).ownerPrior.updateMany({
    where: { id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return res.count > 0;
}

/** List priors, newest first. `activeOnly` filters to the ones the forecast
 *  actually applies right now. */
export async function listOwnerPriors(
  tenantId: string,
  opts?: { activeOnly?: boolean; now?: Date }
): Promise<OwnerPriorRecord[]> {
  const now = opts?.now ?? new Date();
  const rows = await prismaForTenant(tenantId).ownerPrior.findMany({
    where: opts?.activeOnly ? { revokedAt: null } : {},
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      scope: true,
      scopeValue: true,
      expectedUnits: true,
      multiplier: true,
      proxyProductId: true,
      weeks: true,
      note: true,
      createdByName: true,
      createdAt: true,
      revokedAt: true,
    },
  });
  const mapped = rows.map((r) => ({
    ...r,
    scope: (r.scope === "brand" ? "brand" : "product") as OwnerPriorScope,
    active: priorActive({ createdAt: r.createdAt, weeks: r.weeks, revokedAt: r.revokedAt }, now),
  }));
  return opts?.activeOnly ? mapped.filter((r) => r.active) : mapped;
}
