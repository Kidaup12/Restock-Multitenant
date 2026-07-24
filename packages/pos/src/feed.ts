import type { PosLineInput, PosSaleInput } from "./types";

/**
 * POS feed fetch + parse — the ONE seam that needs real POS credentials.
 *
 * The live feed (e.g. Dellwest) is an authenticated per-tenant endpoint we can't
 * reach from dev/CI, so the network call is injectable: `fetchPosFeed` takes an
 * optional fetcher, defaulting to a bearer-authed GET. Everything downstream —
 * the parser and the whole ingest pipeline — runs on a plain payload, so tests
 * and the POST-payload ingest path exercise the real code with no network.
 *
 * To wire a real provider: supply the tenant's feed URL + secret (from
 * TenantConfig.posFeedUrl and a server-side credential) and, if its envelope
 * differs, pass a custom `parse`. The field-mapping below is deliberately
 * permissive so common shapes work unchanged.
 */

export type FeedFetcher = (url: string) => Promise<unknown>;

function bearerFetcher(secret?: string): FeedFetcher {
  return async (url) => {
    const res = await fetch(url, {
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
    });
    if (!res.ok) throw new Error(`POS feed request failed: ${res.status} ${res.statusText}`);
    return res.json();
  };
}

export async function fetchPosFeed(
  url: string,
  opts: { fetch?: FeedFetcher; secret?: string; parse?: (raw: unknown) => PosSaleInput[] } = {}
): Promise<PosSaleInput[]> {
  const raw = await (opts.fetch ?? bearerFetcher(opts.secret))(url);
  return (opts.parse ?? parsePosFeed)(raw);
}

type Loose = Record<string, unknown>;
const asArray = (v: unknown): Loose[] => (Array.isArray(v) ? (v as Loose[]) : []);
const str = (v: unknown): string | null => (typeof v === "string" ? v : v == null ? null : String(v));
const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
const pick = (o: Loose, ...keys: string[]): unknown => {
  for (const k of keys) if (o[k] != null) return o[k];
  return undefined;
};

/** Map a permissive feed envelope ({ sales: [...] } or a bare array) to the
 *  ingest wire shape. Sales missing an id or lines are dropped. */
export function parsePosFeed(raw: unknown): PosSaleInput[] {
  const rows = Array.isArray(raw) ? asArray(raw) : asArray((raw as Loose)?.sales ?? (raw as Loose)?.data);
  const out: PosSaleInput[] = [];
  for (const r of rows) {
    const externalId = str(pick(r, "externalId", "id", "saleId", "reference_no", "referenceNo"));
    const date = str(pick(r, "date", "createdAt", "created_at", "saleDate", "timestamp"));
    if (!externalId || !date) continue;
    const lines = asArray(pick(r, "lines", "items", "products")).map(parseLine).filter(Boolean) as PosLineInput[];
    if (lines.length === 0) continue;
    out.push({
      externalId,
      reference: str(pick(r, "reference", "reference_no", "referenceNo")),
      date,
      createdBy: str(pick(r, "createdBy", "created_by", "cashier", "staff")),
      salesAgent: str(pick(r, "salesAgent", "sales_agent", "agent")),
      warehouse: str(pick(r, "warehouse", "till", "location", "branch", "store")),
      customer: str(pick(r, "customer", "customer_name")),
      saleStatus: str(pick(r, "saleStatus", "sale_status", "status")),
      paymentStatus: str(pick(r, "paymentStatus", "payment_status")),
      grandTotal: num(pick(r, "grandTotal", "grand_total", "total")),
      channel: str(pick(r, "channel", "source")),
      lines,
    });
  }
  return out;
}

function parseLine(l: Loose): PosLineInput | null {
  const sku = str(pick(l, "sku", "code", "itemCode", "item_code", "barcode"));
  const qty = num(pick(l, "qty", "quantity", "units"));
  if (sku == null || qty == null) return null;
  return {
    sku,
    name: str(pick(l, "name", "productName", "product_name", "title", "description")),
    qty,
    price: num(pick(l, "price", "unitPrice", "unit_price")),
    subtotal: num(pick(l, "subtotal", "lineTotal", "line_total", "amount")),
  };
}
