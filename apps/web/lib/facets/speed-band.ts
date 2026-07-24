/**
 * Speed band — a metadata facet derived purely from lead time (spec §"Filters
 * are metadata facets"): Local ≤7d · Regional 8–20d · Import 21d+. These are
 * speed labels, NOT the retired Local/Korean/Western import category. Lead time
 * resolves through @wezesha/forecast's leadDaysFor (product override → supplier
 * average → null); a product with no lead data has no speed band.
 */

export type SpeedBand = "local" | "regional" | "import";

export const SPEED_BANDS: readonly SpeedBand[] = ["local", "regional", "import"];

export const SPEED_BAND_LABELS: Record<SpeedBand, string> = {
  local: "Local (≤7d)",
  regional: "Regional (8–20d)",
  import: "Import (21d+)",
};

/** Lead days → band. Null lead time (no supplier / no measured lead) → null:
 *  the item is surfaced as data to fix, never bucketed on a guess. */
export function speedBandFromLeadDays(leadDays: number | null | undefined): SpeedBand | null {
  if (leadDays == null) return null;
  if (leadDays <= 7) return "local";
  if (leadDays <= 20) return "regional";
  return "import";
}
