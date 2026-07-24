/**
 * Location roles — the single source of truth for how a location's stored
 * `locationType` maps to the CALCULATION ROLE that drives the inventory math.
 * A wrong role silently corrupts the numbers (spec §1), so this mapping lives
 * in exactly one place, imported by both the web app and the sync worker.
 *
 *   sells   — on-hand available to sell → days-of-cover + reorder math
 *   holds   — distributable stock (warehouse) → transfer suggestions only,
 *             NOT counted as sellable on-hand
 *   enroute — on-order → the en-route number (Product.onOrder); never on-hand
 *   ignore  — counts as nothing → excluded everywhere
 *
 * Pure and framework-free: no Prisma, no I/O.
 */

export type LocationRole = "sells" | "holds" | "enroute" | "ignore";

/** DB enum values for Location.locationType. */
export type LocationType = "branch" | "warehouse" | "enroute" | "virtual";
export const LOCATION_TYPES: readonly LocationType[] = [
  "branch",
  "warehouse",
  "enroute",
  "virtual",
] as const;

/** locationType → calculation role. null/unknown → "sells" (the safe default:
 *  spec says an unclassified location is treated as a branch). */
export function roleOfType(locationType: string | null | undefined): LocationRole {
  switch (locationType) {
    case "warehouse":
      return "holds";
    case "enroute":
      return "enroute";
    case "virtual":
      return "ignore";
    case "branch":
    default:
      return "sells";
  }
}

/** Role of a location row (anything carrying locationType). */
export function roleOf(location: { locationType: string | null }): LocationRole {
  return roleOfType(location.locationType);
}

/** Inverse of roleOfType: the DB enum to STORE for a given role. Used by the
 *  sync when it turns a name-guess into a stored locationType. */
export function typeOfRole(role: LocationRole): LocationType {
  switch (role) {
    case "holds":
      return "warehouse";
    case "enroute":
      return "enroute";
    case "ignore":
      return "virtual";
    case "sells":
    default:
      return "branch";
  }
}

export const isSellable = (location: { locationType: string | null }): boolean =>
  roleOf(location) === "sells";
export const isHolds = (location: { locationType: string | null }): boolean =>
  roleOf(location) === "holds";
export const isEnroute = (location: { locationType: string | null }): boolean =>
  roleOf(location) === "enroute";
export const isIgnore = (location: { locationType: string | null }): boolean =>
  roleOf(location) === "ignore";

/**
 * Guess a role from a location name, for the "Assumed — confirm" default. The
 * guess only has to be a decent starting point — the owner confirms it once.
 *
 * Order matters: en-route and holds tokens are checked BEFORE the ignore
 * tokens, because a real distributing warehouse is often named "… (Virtual)"
 * and must not be dropped as Ignore. Bare "store"/"shop" are deliberately NOT
 * holds tokens — a retail "Main Store" sells; only explicit storage words
 * (warehouse/godown/depot/storeroom/storage) map to Holds.
 */
export function guessRoleFromName(name: string | null | undefined): LocationRole {
  const n = (name ?? "").toLowerCase();
  if (!n.trim()) return "sells"; // unknown name → treat as a selling location
  if (/incoming|en[\s-]?route|transit/.test(n)) return "enroute";
  if (/warehouse|godown|depot|store[\s-]?room|stock[\s-]?room|storage/.test(n)) return "holds";
  if (/returns?|damaged?|write[\s-]?off|disposal|virtual|legacy/.test(n)) return "ignore";
  return "sells";
}

/** Human labels for the DB enum, for badges/selects. */
export const LOCATION_TYPE_LABELS: Record<LocationType, string> = {
  branch: "Branch",
  warehouse: "Warehouse",
  enroute: "En route",
  virtual: "Virtual",
};

/** Short "what this role does to the math" copy for the confirm-roles UI. */
export const LOCATION_ROLE_DESCRIPTIONS: Record<LocationRole, string> = {
  sells: "Counts as on-hand you can sell — drives cover and the buy list.",
  holds: "Distributable stock — feeds transfer suggestions, not sellable cover.",
  enroute: "Counts as on-order (en route) — never as on-hand.",
  ignore: "Counts as nothing — excluded from every number.",
};
