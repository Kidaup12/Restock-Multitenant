import type { Prisma } from "@wezesha/db";

/**
 * Drop the Shopify ingest cursors when a workspace changes store.
 *
 * A cursor is a high-water mark for ONE store's data — the worker pulls orders
 * only from it minus an overlap window. Carried across a store swap it means the
 * next sync runs as a delta against a store we have never pulled: the new
 * store's orders from before the old store's mark are never fetched, and nothing
 * ever fetches them later, because the orders cursor is only re-read and never
 * cleared. Run rates are then computed on a history that stops without saying
 * so. (The products cursor is the one exception — the daily full-sync cron
 * deletes it — so that half would right itself within a day. Waiting a day for
 * a catalogue is still the wrong answer, and the other two never right
 * themselves at all.)
 *
 * Scoped to `source: "shopify"`: a cursor belonging to another feed is still a
 * true mark for that feed, which did not change store.
 *
 * Deliberately NOT run for a reconnect to the same domain. Re-pasting a token
 * is routine credential maintenance — both production stores needed it when
 * their tokens expired — and resetting there would mean a full catalogue pull
 * and a year of orders re-fetched on every refresh.
 *
 * Both write paths (the pasted-token action and the OAuth callback) call this
 * inside the same transaction as their upsert, so a failed connect cannot leave
 * a workspace with its cursors gone and its old store still attached.
 */
export async function resetCursorsOnStoreChange(
  tx: Prisma.TransactionClient,
  tenantId: string,
  shopDomain: string
): Promise<number> {
  const existing = await tx.shopifyConnection.findUnique({
    where: { tenantId },
    select: { shopDomain: true },
  });
  if (!existing || existing.shopDomain === shopDomain) return 0;

  const { count } = await tx.ingestCursor.deleteMany({ where: { tenantId, source: "shopify" } });
  return count;
}
