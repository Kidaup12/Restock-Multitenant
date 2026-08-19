"use server";

import { revalidatePath } from "next/cache";
import { LOCATION_TYPES, prismaForTenant, prismaService, type LocationType } from "@wezesha/db";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { recomputeSellableStock } from "@/lib/inventory/sellable-rollup";

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

  // The role decides whether this location's units are sellable, and
  // Product.currentStock is a STORED rollup of exactly that — so the answer to
  // this prompt does not reach a single screen until the rollup is rewritten.
  // Without this the confirmation looked accepted and changed nothing: a shop
  // correcting a warehouse guessed as a shopfront still saw the old buy list,
  // and the only thing that eventually fixed it was an unrelated sync.
  const affected = await db.inventoryLevel.findMany({
    where: { locationId: target.id },
    select: { productId: true },
  });
  await recomputeSellableStock(db, [...new Set(affected.map((l) => l.productId))]);

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
  revalidatePath("/products");
  revalidatePath("/inventory");
  return { ok: true };
}

/**
 * Point a POS till at a branch, so its sales land in that branch's run rate.
 * Upsert on (tenant, till name) — re-pointing a till is a correction, not a
 * second row. Same gate and scoping as the role action: the location is read
 * through the tenant client first, so an id from another tenant is invisible.
 */
export async function mapTillToLocation(input: {
  warehouseName: string;
  locationId: string;
}): Promise<LocationActionResult> {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) return err("You're not in a workspace.");
  if (!hasPermission(membership, "manage_settings")) {
    return err("You don't have settings access.");
  }
  const warehouseName = input.warehouseName.trim();
  if (!warehouseName) return err("Pick a till.");

  const db = prismaForTenant(membership.tenantId);
  const location = await db.location.findUnique({
    where: { id: input.locationId },
    select: { id: true, name: true },
  });
  if (!location) return err("That branch no longer exists.");

  await db.warehouseLocationMap.upsert({
    where: { tenantId_warehouseName: { tenantId: membership.tenantId, warehouseName } },
    create: { tenantId: membership.tenantId, warehouseName, locationId: location.id },
    update: { locationId: location.id },
  });

  await prismaService.auditEvent.create({
    data: {
      tenantId: membership.tenantId,
      entity: "WarehouseLocationMap",
      entityId: warehouseName,
      action: "till_mapped",
      actorUserId: session.user.id,
      actorName: membership.displayName ?? session.user.name ?? session.user.email,
      meta: { till: warehouseName, locationId: location.id, locationName: location.name },
    },
  });

  // The prompt to do this lives on Sales; the result shows on both screens.
  revalidatePath("/settings/locations");
  revalidatePath("/sales");
  return { ok: true };
}

/** Undo a mapping — the till's sales go back to counting for no branch. */
export async function unmapTill(input: { warehouseName: string }): Promise<LocationActionResult> {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) return err("You're not in a workspace.");
  if (!hasPermission(membership, "manage_settings")) {
    return err("You don't have settings access.");
  }

  const db = prismaForTenant(membership.tenantId);
  const existing = await db.warehouseLocationMap.findFirst({
    where: { warehouseName: input.warehouseName.trim() },
    select: { id: true, warehouseName: true, locationId: true },
  });
  if (!existing) return err("That till isn't mapped.");

  await db.warehouseLocationMap.delete({ where: { id: existing.id } });

  await prismaService.auditEvent.create({
    data: {
      tenantId: membership.tenantId,
      entity: "WarehouseLocationMap",
      entityId: existing.warehouseName,
      action: "till_unmapped",
      actorUserId: session.user.id,
      actorName: membership.displayName ?? session.user.name ?? session.user.email,
      meta: { till: existing.warehouseName, locationId: existing.locationId },
    },
  });

  revalidatePath("/settings/locations");
  revalidatePath("/sales");
  return { ok: true };
}
