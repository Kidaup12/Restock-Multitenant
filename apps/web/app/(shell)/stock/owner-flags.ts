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

/** Keyed by product id, for the client table to hand each row its own pair. */
export async function getOwnerFlags(tenantId: string): Promise<Record<string, OwnerFlags>> {
  const rows = await prismaForTenant(tenantId).product.findMany({
    select: { id: true, active: true, activeOverride: true },
  });
  return Object.fromEntries(rows.map((r) => [r.id, { active: r.active, activeOverride: r.activeOverride }]));
}
