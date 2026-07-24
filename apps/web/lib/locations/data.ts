import { prismaForTenant, roleOf, type LocationRole } from "@wezesha/db";
import { guessRoleFromName } from "./roles";

/**
 * Data for the confirm-roles screen. Server-only, RLS-scoped. Cost value is
 * redacted here (not at render) via `canViewCosts`, matching the stock getters.
 */

export type LocationRoleRow = {
  id: string;
  name: string;
  isPrimary: boolean;
  /** Stored DB enum; null = never classified (treated as a branch). */
  locationType: string | null;
  /** Effective calculation role of the stored type. */
  role: LocationRole;
  /** "assumed" (system guess) | "confirmed" (owner) | null (treated assumed). */
  roleStatus: string | null;
  /** True until the owner confirms — drives the "Assumed — confirm" badge. */
  assumed: boolean;
  /** Role guessed from the name, shown when the stored role is only assumed. */
  guessedRole: LocationRole;
  unitsOnHand: number;
  /** On-hand at cost. Null when the caller can't view costs. */
  stockValueKes: number | null;
};

export type LocationRolesData = {
  rows: LocationRoleRow[];
  /** Single-location shops skip the whole feature (spec §1). */
  singleLocation: boolean;
  /** How many locations are still on an assumed (unconfirmed) role. */
  assumedCount: number;
  /** Value of stock sitting in Ignore locations — counts as nothing, so it's
   *  surfaced as a callout. Null when the caller can't view costs. */
  ignoreStockValueKes: number | null;
};

export async function getLocationRoles(
  tenantId: string,
  { canViewCosts }: { canViewCosts: boolean }
): Promise<LocationRolesData> {
  const db = prismaForTenant(tenantId);
  const locations = await db.location.findMany({
    orderBy: [{ isPrimary: "desc" }, { name: "asc" }],
    include: {
      inventoryLevels: { select: { onHand: true, product: { select: { costKes: true } } } },
    },
  });

  let ignoreValue = 0;
  const rows: LocationRoleRow[] = locations.map((location) => {
    const role = roleOf(location);
    const units = location.inventoryLevels.reduce((s, l) => s + l.onHand, 0);
    const value = location.inventoryLevels.reduce((s, l) => s + l.onHand * l.product.costKes, 0);
    if (role === "ignore") ignoreValue += value;
    return {
      id: location.id,
      name: location.name,
      isPrimary: location.isPrimary,
      locationType: location.locationType,
      role,
      roleStatus: location.roleStatus,
      assumed: location.roleStatus !== "confirmed",
      guessedRole: guessRoleFromName(location.name),
      unitsOnHand: units,
      stockValueKes: canViewCosts ? value : null,
    };
  });

  return {
    rows,
    singleLocation: rows.length <= 1,
    assumedCount: rows.filter((r) => r.assumed).length,
    ignoreStockValueKes: canViewCosts ? ignoreValue : null,
  };
}
