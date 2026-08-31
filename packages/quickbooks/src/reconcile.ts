import { prismaForTenant } from "@wezesha/db";
import { activeAccessToken, recordAuthFailure } from "./connection";
import { matchPurchaseOrders, type LocalPurchaseOrder } from "./match";
import {
  QuickBooksApiError,
  fetchPurchaseOrders,
  type QuickBooksPurchaseOrder,
} from "./purchase-orders";

/**
 * Compare a workspace's purchase orders against its books, and record what was
 * found as evidence on the orders.
 *
 * **This never changes what the buy list counts as on order.** The schema calls
 * `qbConfirmedAt` / `qbDocRef` / `qbSuggestion` a parallel evidence track for
 * that reason: a books-matching mistake must not be able to suppress a restock
 * and let a shop run out. It answers "did this reach my books", not "how much
 * is coming".
 *
 * Only the document number confirms. A lookalike is written to `qbSuggestion`
 * for a person to judge and never sets `qbConfirmedAt` — see `match.ts`.
 */

export type ReconcileResult =
  | { ok: false; reason: "not_connected" | "auth_failed" | "api_error"; detail?: string }
  | {
      ok: true;
      confirmed: number;
      suggested: number;
      phantoms: number;
      /** Documents in the books that this system did not raise. */
      external: QuickBooksPurchaseOrder[];
    };

/** How far back to read. Wide enough to catch an order entered late, narrow
 *  enough that a long-running company is not paged through every tick. */
const LOOKBACK_DAYS = 120;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function reconcilePurchaseOrders(options: {
  tenantId: string;
  now?: Date;
  fetchImpl?: typeof fetch;
  /** Days after sending before absence from the books is worth flagging. */
  phantomAfterDays?: number;
}): Promise<ReconcileResult> {
  const now = options.now ?? new Date();
  const token = await activeAccessToken(options.tenantId, now);
  if (!token) return { ok: false, reason: "not_connected" };

  const db = prismaForTenant(options.tenantId);
  const since = new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS);

  // Only orders that were actually sent are expected in the books. A draft is
  // not late, it is unfinished.
  const rows = await db.purchaseOrder.findMany({
    where: { sentAt: { not: null, gte: since } },
    select: {
      id: true,
      poNumber: true,
      vendor: true,
      subtotalKes: true,
      sentAt: true,
      qbConfirmedAt: true,
      supplier: { select: { name: true } },
    },
  });

  let remote: QuickBooksPurchaseOrder[];
  try {
    remote = await fetchPurchaseOrders({
      accessToken: token.accessToken,
      realmId: token.realmId,
      since,
      fetchImpl: options.fetchImpl,
    });
  } catch (err) {
    if (err instanceof QuickBooksApiError && err.unauthorized) {
      // The token was refused after we refreshed it — the grant is gone, not
      // stale. Pausing stops a dead connection retrying every tick forever.
      await recordAuthFailure(options.tenantId, err.message, true);
      return { ok: false, reason: "auth_failed", detail: err.message };
    }
    return {
      ok: false,
      reason: "api_error",
      detail: err instanceof Error ? err.message : "unknown",
    };
  }

  const local: LocalPurchaseOrder[] = rows.map((r) => ({
    id: r.id,
    poNumber: r.poNumber,
    vendor: r.supplier?.name ?? r.vendor,
    subtotalKes: r.subtotalKes,
    sentAt: r.sentAt,
  }));

  const result = matchPurchaseOrders(local, remote, {
    now,
    phantomAfterDays: options.phantomAfterDays,
  });

  // Confirmation is a one-way latch: the first match wins and later runs leave
  // it alone, so a document deleted in the books months later cannot quietly
  // un-confirm an order that really was raised.
  const alreadyConfirmed = new Set(rows.filter((r) => r.qbConfirmedAt).map((r) => r.id));
  for (const match of result.confirmed) {
    if (alreadyConfirmed.has(match.localId)) continue;
    await db.purchaseOrder.updateMany({
      where: { id: match.localId, qbConfirmedAt: null },
      data: {
        qbConfirmedAt: now,
        qbDocRef: match.qbDocNumber ?? match.qbId,
        qbSuggestion: null,
        needsAttention: false,
      },
    });
  }

  for (const suggestion of result.suggestions) {
    if (alreadyConfirmed.has(suggestion.localId)) continue;
    await db.purchaseOrder.updateMany({
      where: { id: suggestion.localId, qbConfirmedAt: null },
      data: { qbSuggestion: `${suggestion.label} — ${suggestion.reason}` },
    });
  }

  const confirmedIds = new Set(result.confirmed.map((m) => m.localId));
  for (const phantom of result.phantoms) {
    if (confirmedIds.has(phantom.id) || alreadyConfirmed.has(phantom.id)) continue;
    await db.purchaseOrder.updateMany({
      where: { id: phantom.id, qbConfirmedAt: null },
      data: { needsAttention: true },
    });
  }

  return {
    ok: true,
    confirmed: result.confirmed.length,
    suggested: result.suggestions.length,
    phantoms: result.phantoms.length,
    external: result.external,
  };
}
