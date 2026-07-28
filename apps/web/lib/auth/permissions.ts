import type { Role } from "@wezesha/db";

/**
 * Permission keys and role presets. A Membership's `permissions` Json is null
 * to inherit the role's preset; a non-null array (even an empty one) is an
 * explicit per-member override. Values in a stored array that aren't known
 * keys are ignored, so retiring a key never breaks resolution.
 */

export const PERMISSION_KEYS = [
  "view_costs",
  "manage_team",
  "manage_settings",
  "approve_orders",
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

/**
 * MEMBER is the money-blind shop-floor role: no costs, no team control, and no
 * workspace administration — settings, the supplier book, the product catalogue
 * and forecast priors all sit behind `manage_settings`. A member still works
 * the orders they were hired to work (`approve_orders`). Where one member does
 * need to edit settings, grant it per-membership rather than widening the role.
 */
export const ROLE_PRESETS: Record<Role, readonly PermissionKey[]> = {
  OWNER: PERMISSION_KEYS,
  ADMIN: PERMISSION_KEYS,
  MEMBER: ["approve_orders"],
};

/** The membership fields resolution needs — assignable from a Prisma row. */
export type PermissionSource = {
  role: Role;
  permissions: unknown;
};

function isPermissionKey(value: unknown): value is PermissionKey {
  return (PERMISSION_KEYS as readonly string[]).includes(value as string);
}

/** Effective permission set: the override array when non-null, else the preset. */
export function resolvePermissions(
  membership: PermissionSource,
): Set<PermissionKey> {
  if (Array.isArray(membership.permissions)) {
    return new Set(membership.permissions.filter(isPermissionKey));
  }
  return new Set(ROLE_PRESETS[membership.role]);
}

export function hasPermission(
  membership: PermissionSource,
  key: PermissionKey,
): boolean {
  return resolvePermissions(membership).has(key);
}
