import { isSellable, sellableUnits } from "@wezesha/db";

/**
 * Recompute `Product.currentStock` — the SELLABLE on-hand rollup.
 *
 * `currentStock` is stored, not derived at read time, so anything that changes
 * either the units at a location OR whether that location sells has to rewrite
 * it. Receiving already did this correctly and privately; confirming a
 * location's role did not do it at all, which meant the prompt that exists to
 * correct which stock counts as sellable changed no number on any screen until
 * the next sync happened to rewrite the rollup for its own reasons.
 *
 * Both halves of the sum matter. Summing every level lets warehouse stock
 * inflate sellable cover; summing `onHand` instead of `available` undoes the
 * sync's committed-unit subtraction, and the buy list starts asking for units
 * that are already promised to a customer.
 *
 * A product whose sellable levels all disappear must land on 0, not keep its old
 * figure — that is exactly the case when a shopfront is re-confirmed as a
 * warehouse, and leaving the stale number behind would be the same silent
 * corruption in the other direction.
 */

/** The slice of a Prisma client this needs — so it takes either a tenant client
 *  or an interactive transaction without either caller casting. */
type RollupClient = {
  inventoryLevel: {
    findMany(args: {
      where: { productId: { in: string[] } };
      select: {
        productId: true;
        available: true;
        onHand: true;
        location: { select: { locationType: true } };
      };
    }): Promise<
      {
        productId: string;
        available: number | null;
        onHand: number;
        location: { locationType: string | null } | null;
      }[]
    >;
  };
  product: {
    update(args: {
      where: { id: string };
      data: { currentStock: number };
    }): Promise<unknown>;
  };
};

export async function recomputeSellableStock(
  db: RollupClient,
  productIds: string[]
): Promise<void> {
  if (productIds.length === 0) return;

  const levels = await db.inventoryLevel.findMany({
    where: { productId: { in: productIds } },
    select: {
      productId: true,
      available: true,
      onHand: true,
      location: { select: { locationType: true } },
    },
  });

  // Seeded at zero so a product that no longer has a sellable level is written
  // down rather than left at its previous figure.
  const sellableByProduct = new Map<string, number>(productIds.map((id) => [id, 0]));
  for (const level of levels) {
    if (!level.location || !isSellable(level.location)) continue;
    sellableByProduct.set(
      level.productId,
      (sellableByProduct.get(level.productId) ?? 0) + sellableUnits(level)
    );
  }

  for (const [productId, currentStock] of sellableByProduct) {
    await db.product.update({ where: { id: productId }, data: { currentStock } });
  }
}
