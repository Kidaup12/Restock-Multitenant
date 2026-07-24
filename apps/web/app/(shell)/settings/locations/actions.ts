"use server";

import { revalidatePath } from "next/cache";
import { LOCATION_TYPES, prismaForTenant, prismaService, type LocationType } from "@wezesha/db";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";

/**
 * Confirm (or change) a location's role. Only MANAGE_SETTINGS members may do
 * this. The write goes through the tenant-scoped client, so a location id from
 * another tenant resolves to nothing under RLS; the audit row rides on the
 * service client so no tenant role can filter it.
 */

export type LocationActionResult = { ok: true } | { ok: false; error: string };

const err = (error: string): LocationActionResult => ({ ok: false, error });

function isLocationType(value: string): value is LocationType {
  return (LOCATION_TYPES as readonly string[]).includes(value);
}

export async function setLocationRole(input: {
  locationId: string;
  locationType: string;
}): Promise<LocationActionResult> {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) return err("You're not in a workspace.");
  if (!hasPermission(membership, "manage_settings")) {
    return err("You don't have settings access.");
  }
  if (!isLocationType(input.locationType)) return err("Unknown role.");

  const db = prismaForTenant(membership.tenantId);
  const target = await db.location.findUnique({
    where: { id: input.locationId },
    select: { id: true, name: true, locationType: true, roleStatus: true },
  });
  if (!target) return err("That location no longer exists.");

  await db.location.update({
    where: { id: target.id },
    data: { locationType: input.locationType, roleStatus: "confirmed" },
  });

  await prismaService.auditEvent.create({
    data: {
      tenantId: membership.tenantId,
      entity: "Location",
      entityId: target.id,
      action: "role_confirmed",
      actorUserId: session.user.id,
      actorName: membership.displayName ?? session.user.name ?? session.user.email,
      meta: {
        name: target.name,
        from: target.locationType,
        to: input.locationType,
        wasStatus: target.roleStatus,
      },
    },
  });

  // Roles drive the live stock queries, so refresh both surfaces.
  revalidatePath("/settings/locations");
  revalidatePath("/stock");
  return { ok: true };
}
