/**
 * The A/B/C lens on a report table.
 *
 * Reports carried class chips on exactly one table (top earners); the two that
 * hold the money problems — empty shelves and cash asleep — had no class column
 * and no way to ask "show me my dead A items", which is the question the whole
 * classification exists to answer.
 *
 * `unrated` is a first-class choice, not a tidy-up. Product.abcCategory is
 * written by the nightly run and is null until it has completed, so a shop in
 * its first days has an entirely unrated catalogue. Folding those rows into
 * "all" and nowhere else would leave them findable only by scrolling; dropping
 * them from "all" would show an empty report to a shop whose data is fine.
 */

export const ABC_KEYS = ["all", "A", "B", "C", "unrated"] as const;

export type AbcKey = (typeof ABC_KEYS)[number];

export const DEFAULT_ABC: AbcKey = "all";

const LABELS: Record<AbcKey, string> = {
  all: "All",
  A: "A",
  B: "B",
  C: "C",
  unrated: "Unrated",
};

/** Falls back rather than throwing: this reads a query string. */
export function parseAbcKey(raw: string | null | undefined): AbcKey {
  return (ABC_KEYS as readonly string[]).includes(raw ?? "") ? (raw as AbcKey) : DEFAULT_ABC;
}

export function abcLabel(key: AbcKey): string {
  return LABELS[key];
}

/** Whether a row belongs under the chosen lens. */
export function matchesAbc(row: { abc: string | null }, key: AbcKey): boolean {
  if (key === "all") return true;
  if (key === "unrated") return row.abc == null;
  return row.abc === key;
}
