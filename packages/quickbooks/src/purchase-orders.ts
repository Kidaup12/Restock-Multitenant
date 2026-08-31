import { apiBaseUrl } from "./env";

/**
 * Reading purchase orders out of a company's books.
 *
 * Only what matching needs: the document's identity, who it is for, what it is
 * worth and when it was raised. Line items are deliberately not read — matching
 * works at document level, and pulling lines would mean holding a shop's
 * itemised purchasing in memory for no gain.
 */
export type QuickBooksPurchaseOrder = {
  /** Intuit's entity id. Stable, and what we record as evidence. */
  id: string;
  /** The number a human sees on the document. Often, but not always, set. */
  docNumber: string | null;
  totalAmt: number | null;
  /** Transaction date, `YYYY-MM-DD` as Intuit returns it. */
  txnDate: string | null;
  vendorName: string | null;
};

export class QuickBooksApiError extends Error {
  readonly status: number;
  /** 401 means the token is dead: refresh, or ask the shop to reconnect.
   *  Anything else is worth retrying on the next tick. */
  readonly unauthorized: boolean;

  constructor(message: string, status: number) {
    super(message);
    this.name = "QuickBooksApiError";
    this.status = status;
    this.unauthorized = status === 401;
  }
}

/** Intuit dates are plain `YYYY-MM-DD` in the company's own timezone. */
function asQueryDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

type QueryResponse = {
  QueryResponse?: {
    PurchaseOrder?: Array<{
      Id?: string;
      DocNumber?: string;
      TotalAmt?: number;
      TxnDate?: string;
      VendorRef?: { value?: string; name?: string };
    }>;
  };
};

const PAGE_SIZE = 100;

/**
 * Every purchase order raised on or after `since`, across as many pages as the
 * company has.
 *
 * `maxPages` is a backstop, not a business rule: a company with years of
 * purchasing and a wide `since` would otherwise page indefinitely on a worker
 * tick. When it bites the caller gets what was read rather than an error —
 * partial evidence still confirms the orders it covers, and the next tick
 * starts from the same place.
 */
export async function fetchPurchaseOrders(options: {
  accessToken: string;
  realmId: string;
  since: Date;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  maxPages?: number;
}): Promise<QuickBooksPurchaseOrder[]> {
  const base = options.baseUrl ?? apiBaseUrl();
  const doFetch = options.fetchImpl ?? fetch;
  const maxPages = options.maxPages ?? 20;
  const out: QuickBooksPurchaseOrder[] = [];

  for (let page = 0; page < maxPages; page++) {
    const startPosition = page * PAGE_SIZE + 1;
    const query =
      `SELECT Id, DocNumber, TotalAmt, TxnDate, VendorRef FROM PurchaseOrder ` +
      `WHERE TxnDate >= '${asQueryDate(options.since)}' ` +
      `ORDER BY TxnDate STARTPOSITION ${startPosition} MAXRESULTS ${PAGE_SIZE}`;
    const url =
      `${base}/v3/company/${encodeURIComponent(options.realmId)}/query` +
      `?query=${encodeURIComponent(query)}&minorversion=75`;

    const res = await doFetch(url, {
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      throw new QuickBooksApiError(
        `QuickBooks refused the purchase-order query (${res.status})`,
        res.status
      );
    }

    const body = (await res.json()) as QueryResponse;
    const rows = body.QueryResponse?.PurchaseOrder ?? [];
    for (const row of rows) {
      if (!row.Id) continue; // no identity, nothing to record as evidence
      out.push({
        id: row.Id,
        docNumber: row.DocNumber?.trim() || null,
        totalAmt: typeof row.TotalAmt === "number" ? row.TotalAmt : null,
        txnDate: row.TxnDate?.trim() || null,
        vendorName: row.VendorRef?.name?.trim() || null,
      });
    }
    // A short page is the last page. Intuit signals the end this way rather
    // than with a cursor or a total.
    if (rows.length < PAGE_SIZE) break;
  }

  return out;
}
