/**
 * What is genuinely on its way to the shelf — one rule, two callers.
 *
 * There are two independent views of inbound stock and they do not agree:
 *
 *   1. `Product.onOrder` — SHOPIFY's view. Stock sitting at an en-route
 *      location plus Shopify's own `incoming` count. It knows nothing about a
 *      purchase order we sent ourselves.
 *   2. Our own outstanding purchase orders — sent or partially received, not
 *      yet fully delivered. Most stock in transit got there because of one.
 *
 * Between sending a PO and the shop recording that delivery in Shopify, only
 * the second view knows anything, so a product that has already been ordered
 * looks un-ordered and gets recommended again.
 *
 * Combined with MAX, never a sum: once the shop does record the delivery as
 * incoming, both views describe the SAME physical units, and adding them would
 * double count and suppress a reorder that is genuinely due.
 *
 * Draft POs are excluded — nothing has been ordered yet, and the buy list warns
 * about those separately. Cancelled and fully received lines drop out on their
 * status or their received quantity.
 */

/** PO statuses whose undelivered units count as inbound. */
export const OUTSTANDING_PO_STATUSES = ["sent", "partially_received"] as const;

/** Units on a PO line still to arrive; never negative on an over-receipt. */
export function outstandingUnits(line: { quantity: number; receivedQty: number }): number {
  return Math.max(0, line.quantity - line.receivedQty);
}

/** Sum outstanding units per product from PO lines already filtered to
 *  OUTSTANDING_PO_STATUSES. */
export function outstandingByProduct(
  lines: { productId: string; quantity: number; receivedQty: number }[]
): Map<string, number> {
  const byProduct = new Map<string, number>();
  for (const line of lines) {
    const outstanding = outstandingUnits(line);
    if (outstanding > 0) {
      byProduct.set(line.productId, (byProduct.get(line.productId) ?? 0) + outstanding);
    }
  }
  return byProduct;
}

/** The inbound figure every surface should show and every calculation should
 *  use. See the MAX reasoning above. */
export function effectiveOnOrder(shopifyOnOrder: number, outstandingPoUnits: number): number {
  return Math.max(shopifyOnOrder, outstandingPoUnits);
}

/**
 * When inbound stock is due, per product: the EARLIEST promised date among the
 * outstanding POs that carry one.
 *
 * Derived rather than stored. `Product.expectedArrivalAt` exists in the schema
 * and was read by two screens, but nothing ever wrote it — the PO paths write
 * `Order.expectedArrivalAt`, a different model — so the catalogue printed
 * "no ETA" against every product it had on order. A denormalised copy also has
 * to be cleared when a PO is cancelled or received; deriving it cannot go stale.
 *
 * Earliest rather than latest: it answers "when does something arrive", which
 * is what the shelf cares about. A PO with no promised date contributes none.
 */
export function earliestEtaByProduct(
  lines: {
    productId: string;
    quantity: number;
    receivedQty: number;
    purchaseOrder: { expectedAt: Date | null };
  }[]
): Map<string, Date> {
  const byProduct = new Map<string, Date>();
  for (const line of lines) {
    const eta = line.purchaseOrder.expectedAt;
    if (!eta || outstandingUnits(line) === 0) continue;
    const current = byProduct.get(line.productId);
    if (!current || eta < current) byProduct.set(line.productId, eta);
  }
  return byProduct;
}
