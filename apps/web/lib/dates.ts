/**
 * Date formatting for the screen. One producer per format, so two surfaces
 * showing the same date cannot drift into showing it two ways.
 */

/** Arrival date on inbound stock: "20 Aug". */
export function formatEta(date: Date): string {
  return new Date(date).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
