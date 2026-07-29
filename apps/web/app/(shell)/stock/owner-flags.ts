import { prismaForTenant } from "@wezesha/db";

/**
 * The owner's own switches on a product: `active` (archived / restored by hand)
 * and `activeOverride` ("keep active" — the pin the catalogue sync must respect).
 *
 * They live here rather than on the catalogue row because they are editor state,
 * not a metric: every other surface reads the resolved lifecycle, and only the
 * row editor needs to know which of the two switches produced it. A row whose
 * store status is archived reads as "archived" whether or not the owner also
 * deactivated it, so the buttons cannot be derived from the lifecycle label.
 */

export type OwnerFlags = { active: boolean; activeOverride: boolean };

/** Keyed by product id, for the client table to hand each row its own pair.
 *
 *  Deliberately loads the whole catalogue rather than the page: which ids are on
 *  the page is only known once the catalogue load has finished, so narrowing the
 *  query here would put this request behind that one instead of beside it. Two
 *  booleans per product is a cheap read; a serialised round trip is not. Use
 *  `forProducts` to keep only the rows that will be rendered. */
export async function getOwnerFlags(tenantId: string): Promise<Record<string, OwnerFlags>> {
  const rows = await prismaForTenant(tenantId).product.findMany({
    select: { id: true, active: true, activeOverride: true },
  });
  return Object.fromEntries(rows.map((r) => [r.id, { active: r.active, activeOverride: r.activeOverride }]));
}

/** The subset the table will actually render. Only a rendered row can be edited,
 *  so sending the switches for every product would put a second copy of the
 *  catalogue in the payload for no one to use. */
export function forProducts(
  flags: Record<string, OwnerFlags>,
  productIds: string[]
): Record<string, OwnerFlags> {
  const out: Record<string, OwnerFlags> = {};
  for (const id of productIds) {
    const f = flags[id];
    if (f) out[id] = f;
  }
  return out;
}
