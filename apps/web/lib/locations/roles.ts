/**
 * Web entry point for location-role logic. The mapping/guessing itself lives in
 * @wezesha/db (one source of truth, shared with the sync worker); this module
 * re-exports it and adds the presentation-only bits the UI needs.
 */

export {
  LOCATION_ROLE_DESCRIPTIONS,
  LOCATION_TYPE_LABELS,
  LOCATION_TYPES,
  guessRoleFromName,
  isEnroute,
  isHolds,
  isIgnore,
  isSellable,
  roleOf,
  roleOfType,
} from "@wezesha/db";
export type { LocationRole, LocationType } from "@wezesha/db";

/** Cover-signal thresholds for the by-location stock hub (spec §1 / §10):
 *  green ≥14d, amber 7–14d, red <7d, and red when oversold (negative on hand). */
export type CoverTone = "ok" | "warn" | "danger";

export function coverTone(daysCover: number | null, oversold = false): CoverTone {
  if (oversold) return "danger";
  if (daysCover === null) return "ok"; // no run rate to judge against — no alarm
  if (daysCover < 7) return "danger";
  if (daysCover < 14) return "warn";
  return "ok";
}
