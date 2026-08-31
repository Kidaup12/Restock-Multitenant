import type { QuickBooksPurchaseOrder } from "./purchase-orders";

/**
 * Deciding which QuickBooks document is which of our purchase orders.
 *
 * The point of this is telling orders apart, not merging them. Three questions
 * a shop actually has:
 *   - did the order I sent ever reach my books?          (confirmed)
 *   - which orders did I send that never got there?      (phantom)
 *   - what is in my books that I did not raise here?     (external)
 *
 * Deliberately conservative. Only the document number confirms — everything
 * else is offered as a suggestion for a person to look at, and never written as
 * confirmation. A wrong auto-confirm tells a shop an order is safely on its
 * books when it is not, which is worse than saying nothing: it is the failure
 * the phantom check exists to catch, produced by the check itself.
 *
 * This is an EVIDENCE track. Nothing here changes what the buy list counts as
 * on order — see `PurchaseOrder.qbConfirmedAt` in the schema.
 */

export type LocalPurchaseOrder = {
  id: string;
  poNumber: string;
  /** Supplier or brand label, whichever the order carries. */
  vendor: string | null;
  subtotalKes: number;
  /** Null for an order never sent — those are not expected in the books yet. */
  sentAt: Date | null;
};

export type QuickBooksMatch = {
  localId: string;
  /** Intuit entity id, recorded on confirmation for audit and dedupe. */
  qbId: string;
  qbDocNumber: string | null;
};

export type QuickBooksSuggestion = {
  localId: string;
  qbId: string;
  /** Human label for the lookalike, shown to a person who decides. */
  label: string;
  reason: string;
};

export type MatchResult = {
  /** Document numbers agreed — safe to record as confirmed. */
  confirmed: QuickBooksMatch[];
  /** Looks like it, but a person decides. Never auto-confirms. */
  suggestions: QuickBooksSuggestion[];
  /** Sent long enough ago that absence from the books is worth flagging. */
  phantoms: LocalPurchaseOrder[];
  /** In the books, raised outside this system. The "told apart" half. */
  external: QuickBooksPurchaseOrder[];
};

/** Compare document numbers the way people do: case and padding are noise. */
function normalizeDocNumber(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toUpperCase().replace(/\s+/g, "");
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeVendor(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase().replace(/\s+/g, " ");
  return trimmed.length > 0 ? trimmed : null;
}

/** Within a percent of each other, so rounding and small freight differences
 *  do not stop a suggestion, while genuinely different amounts do. */
function amountsLookAlike(a: number, b: number, tolerance: number): boolean {
  if (a <= 0 || b <= 0) return false;
  return Math.abs(a - b) <= Math.max(a, b) * tolerance;
}

export type MatchOptions = {
  /** How long after sending an order its absence becomes worth flagging. */
  phantomAfterDays?: number;
  /** Relative tolerance when amounts are compared for a suggestion. */
  amountTolerance?: number;
  now?: Date;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function matchPurchaseOrders(
  local: readonly LocalPurchaseOrder[],
  remote: readonly QuickBooksPurchaseOrder[],
  options: MatchOptions = {}
): MatchResult {
  const phantomAfterDays = options.phantomAfterDays ?? 3;
  const amountTolerance = options.amountTolerance ?? 0.02;
  const now = options.now ?? new Date();

  const confirmed: QuickBooksMatch[] = [];
  const suggestions: QuickBooksSuggestion[] = [];
  const phantoms: LocalPurchaseOrder[] = [];

  // A QB document belongs to at most one of our orders. Claimed ones drop out
  // of "external" — otherwise every confirmed order would also be reported as
  // something the shop did not raise here, which is the opposite of the truth.
  const claimed = new Set<string>();

  const byDocNumber = new Map<string, QuickBooksPurchaseOrder>();
  for (const doc of remote) {
    const key = normalizeDocNumber(doc.docNumber);
    // First one wins on a duplicate number: with two candidates there is no
    // evidence which is meant, so confirming either would be a guess.
    if (key && !byDocNumber.has(key)) byDocNumber.set(key, doc);
  }

  for (const order of local) {
    const key = normalizeDocNumber(order.poNumber);
    const exact = key ? byDocNumber.get(key) : undefined;
    if (exact) {
      confirmed.push({ localId: order.id, qbId: exact.id, qbDocNumber: exact.docNumber });
      claimed.add(exact.id);
      continue;
    }

    // Not in the books under our number. Offer the closest lookalike, and flag
    // it as missing once it is old enough that a delay is not the explanation.
    const vendor = normalizeVendor(order.vendor);
    const lookalike = remote.find(
      (doc) =>
        !claimed.has(doc.id) &&
        doc.totalAmt != null &&
        amountsLookAlike(order.subtotalKes, doc.totalAmt, amountTolerance) &&
        (vendor == null || normalizeVendor(doc.vendorName) === vendor)
    );
    if (lookalike) {
      suggestions.push({
        localId: order.id,
        qbId: lookalike.id,
        label: lookalike.docNumber ?? lookalike.id,
        reason: lookalike.vendorName
          ? `same supplier and amount as ${lookalike.vendorName}`
          : "same amount",
      });
    }

    if (order.sentAt && now.getTime() - order.sentAt.getTime() >= phantomAfterDays * DAY_MS) {
      phantoms.push(order);
    }
  }

  // Suggestions do NOT claim a document: it is still unaccounted for in the
  // books until a person says otherwise, and hiding it from the external list
  // on a guess is how a real external order goes unnoticed.
  const external = remote.filter((doc) => !claimed.has(doc.id));

  return { confirmed, suggestions, phantoms, external };
}
