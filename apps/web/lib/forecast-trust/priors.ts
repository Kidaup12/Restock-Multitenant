import { activeMembership, getSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import {
  createOwnerPrior,
  listOwnerPriors,
  revokeOwnerPrior,
  type CreateOwnerPriorInput,
  type OwnerPriorRecord,
} from "@wezesha/forecast-run";

/**
 * "Tell the forecast something" write path (spec §6). Session + tenant + the
 * manage_settings gate resolve here; the actual create/list/revoke lives in
 * @wezesha/forecast-run so the same logic serves any future caller. The trust
 * SURFACES (the Forecast page's prior box, the cold-start queue) render this
 * data in a later wave — this only exposes it.
 */

export type PriorResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string };

type Gate =
  | { ok: true; tenantId: string; actor: { userId: string; name: string | null } }
  | { ok: false; status: number; error: string };

/** Owner/admin (or an explicit manage_settings grant) may tell the forecast. */
async function requireSettingsAccess(): Promise<Gate> {
  const session = await getSession();
  if (!session) return { ok: false, status: 401, error: "unauthorized" };
  const membership = await activeMembership(session.user.id);
  if (!membership) return { ok: false, status: 403, error: "no workspace" };
  if (!hasPermission(membership, "manage_settings")) {
    return { ok: false, status: 403, error: "you do not have permission to change forecast settings" };
  }
  return {
    ok: true,
    tenantId: membership.tenantId,
    actor: { userId: session.user.id, name: membership.displayName ?? null },
  };
}

export async function listPriorsForActiveTenant(opts?: {
  activeOnly?: boolean;
}): Promise<PriorResult<OwnerPriorRecord[]>> {
  const gate = await requireSettingsAccess();
  if (!gate.ok) return gate;
  return { ok: true, data: await listOwnerPriors(gate.tenantId, opts) };
}

export async function createPriorForActiveTenant(
  input: Omit<CreateOwnerPriorInput, "createdByUserId" | "createdByName">
): Promise<PriorResult<{ id: string }>> {
  const gate = await requireSettingsAccess();
  if (!gate.ok) return gate;
  const res = await createOwnerPrior(gate.tenantId, {
    ...input,
    createdByUserId: gate.actor.userId,
    createdByName: gate.actor.name,
  });
  if (!res.ok) return { ok: false, status: 400, error: res.error };
  return { ok: true, data: { id: res.id } };
}

export async function revokePriorForActiveTenant(id: string): Promise<PriorResult<{ revoked: boolean }>> {
  const gate = await requireSettingsAccess();
  if (!gate.ok) return gate;
  const revoked = await revokeOwnerPrior(gate.tenantId, id);
  if (!revoked) return { ok: false, status: 404, error: "prior not found or already revoked" };
  return { ok: true, data: { revoked: true } };
}
