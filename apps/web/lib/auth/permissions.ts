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

/** MEMBER is the money-blind operational role: no costs, no team control. */
export const ROLE_PRESETS: Record<Role, readonly PermissionKey[]> = {
  OWNER: PERMISSION_KEYS,
  ADMIN: PERMISSION_KEYS,
  MEMBER: ["manage_settings", "approve_orders"],
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
