"use server";

import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import {
  getStockByLocation,
  matchesLocationLine,
  compareLocationLines,
  type LocationsQuery,
} from "@/lib/data/stock";
import type { InventoryExportRow } from "./inventory-export";

/**
 * Every line the reader's search matches, across every branch — not the page
 * on screen.
 *
 * The table holds one page, so the browser cannot build this file from what it
 * has; an export of "the fifty rows you happen to be looking at" is the wrong
 * file, particularly for a stock count.
 *
 * `canViewCosts` is re-derived from the caller's own membership rather than
 * trusted from the request, exactly as the screen does — the redaction lives in
 * the getter, and this path is no exception.
 */
export async function exportInventoryAction(
  query: LocationsQuery,
): Promise<InventoryExportRow[]> {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) return [];

  const canViewCosts = hasPermission(membership, "view_costs");
  const locations = await getStockByLocation(membership.tenantId, { canViewCosts });

  return locations.flatMap((location) =>
    (query.search
      ? location.lines.filter((line) => matchesLocationLine(line, query.search))
      : [...location.lines]
    )
      .sort((a, b) => compareLocationLines(a, b, query.sortKey, query.desc))
      .map((line) => ({
        location: location.name,
        title: line.title,
        sku: line.sku,
        onHand: line.onHand,
        // The same shop-wide figures the columns carry, and named the same way
        // so a file and the screen it came from cannot disagree.
        daysCover: line.daysCover,
        onOrderUnits: line.onOrderUnits,
        valueKes: line.valueKes,
      })),
  );
}
