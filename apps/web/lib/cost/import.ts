/**
 * Cost upload / paste (spec §4) — the whole cost story for a tenant without
 * QuickBooks. Drop a CSV or paste rows → a DETERMINISTIC preview
 * (matched / ambiguous-skipped / unknown-skipped) → apply. Nothing is written
 * until apply, and a manual pin is never silently overwritten.
 *
 * This module is pure: it parses the text and matches rows to products the
 * caller loads. The DB write (manual pin + audit) lives in the server action, so
 * the preview and the apply run over the same deterministic plan.
 */

const HEADER_ALIASES: Record<"sku" | "name" | "cost", string[]> = {
  sku: ["sku", "product sku", "item sku", "code", "default code", "barcode"],
  name: ["name", "product", "product name", "title", "item", "item name", "display name"],
  cost: [
    "cost",
    "purchase cost",
    "cost price",
    "unit cost",
    "buy price",
    "cost kes",
    "costkes",
    "landed cost",
    "avg cost",
    "average cost",
  ],
};

/** RFC-4180-ish parser: quoted fields, escaped quotes, CRLF. Blank lines dropped. */
export function parseDelimited(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === "," || c === "\t") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

function mapHeaders(headerRow: string[]): Map<"sku" | "name" | "cost", number> {
  const map = new Map<"sku" | "name" | "cost", number>();
  headerRow.forEach((h, idx) => {
    const norm = h.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
    for (const key of ["sku", "name", "cost"] as const) {
      if (!map.has(key) && HEADER_ALIASES[key].includes(norm)) map.set(key, idx);
    }
  });
  return map;
}

/** Same normalisation both sides of a name match: lowercase, drop punctuation,
 *  collapse whitespace. */
export function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

/** A cost cell either yields a positive number or a note the owner can act on. */
type CostCell = { cost: number; note: null } | { cost: null; note: string };

/**
 * Parse a money cell ("1,234.50", "KES 250", " 900 ") → a positive number, or a
 * note saying what to fix. Currency symbols/codes and whitespace are ignored;
 * a comma is a thousands separator and a dot is the decimal point.
 *
 * Rejected rather than coerced, because a silently "corrected" cost becomes a
 * believable-but-wrong margin and buy quantity:
 *   - zero or blank (zero-as-missing)
 *   - negatives in any notation: "-50", "50-", "(50)"
 *   - anything with two decimal points or comma groups that aren't thousands
 *     ("1.234.50", "1.234,50") — the intended value can't be known.
 */
function parseCostCell(raw: string | undefined | null): CostCell {
  const text = String(raw ?? "").trim();
  if (text === "") return { cost: null, note: "No cost given — add a purchase cost for this row." };
  // A cell with no digits at all is missing, not negative — spreadsheets often
  // write a bare dash for "nothing here", and calling that negative reads as a
  // different problem than the one the owner has.
  if (!/[0-9]/.test(text)) return { cost: null, note: `Cost "${text}" isn't a number.` };

  // Sign markers survive currency symbols and spacing ("KES -50", "(50)").
  if (/[-()]/.test(text.replace(/[^0-9.,()\- ]/g, ""))) {
    return {
      cost: null,
      note: `Cost "${text}" is negative — enter what you pay for one unit, as a positive number.`,
    };
  }

  // Drop currency symbols/codes and spaces; keep only the number and its separators.
  const digits = text.replace(/[^0-9.,]/g, "");
  if (!/[0-9]/.test(digits)) return { cost: null, note: `Cost "${text}" isn't a number.` };
  if ((digits.match(/\./g) ?? []).length > 1) {
    return {
      cost: null,
      note: `Cost "${text}" has more than one decimal point — write it like 1,234.50.`,
    };
  }
  if (digits.includes(",") && !/^[0-9]{1,3}(,[0-9]{3})*(\.[0-9]+)?$/.test(digits)) {
    return {
      cost: null,
      note: `Cost "${text}" — use a dot for decimals and commas only for thousands, like 1,234.50.`,
    };
  }

  const n = Number.parseFloat(digits.replace(/,/g, ""));
  if (!Number.isFinite(n)) return { cost: null, note: `Cost "${text}" isn't a number.` };
  if (n === 0) return { cost: null, note: "Cost is zero — enter the real purchase cost." };
  return { cost: n, note: null };
}

/** Positive parsed cost, or null when the cell is unusable (see parseCostCell). */
export function parseCost(raw: string | undefined | null): number | null {
  return parseCostCell(raw).cost;
}

export type MatchProduct = {
  id: string;
  sku: string | null;
  title: string;
  costSource: string | null;
};

export type PreviewStatus = "matched" | "ambiguous" | "unknown" | "invalid";

export type CostImportPreviewRow = {
  /** 1-based data-row number (header excluded). */
  rowNumber: number;
  sku: string | null;
  name: string | null;
  /** Parsed positive cost, or null when the row's cost is unusable. */
  costKes: number | null;
  status: PreviewStatus;
  /** Set when matched. */
  productId: string | null;
  title: string | null;
  /** Matched product is currently manual-pinned — apply skips it unless the
   *  owner confirms the overwrite. */
  pinned: boolean;
  /** Why the row was skipped (ambiguous / unknown / invalid). */
  note: string | null;
};

export type CostImportPreview = {
  rows: CostImportPreviewRow[];
  summary: {
    total: number;
    matched: number;
    /** Matched rows already manual-pinned (held back unless overwrite confirmed). */
    pinned: number;
    ambiguous: number;
    unknown: number;
    invalid: number;
  };
};

export type CostImportError = { error: string };

/**
 * Build the deterministic preview. Matching is exact and unguessed:
 *   1. exact SKU — unless that SKU sits on more than one product (ambiguous).
 *   2. exact normalised name — unless the name is shared (ambiguous).
 *   3. otherwise unknown.
 * A row with no usable cost is "invalid". Nothing here writes.
 */
export function previewCostImport(
  text: string,
  products: MatchProduct[],
): CostImportPreview | CostImportError {
  const rows = parseDelimited(text);
  if (rows.length < 2) return { error: "Add a header row plus at least one cost row." };

  const headers = mapHeaders(rows[0]!);
  if (!headers.has("cost")) {
    return {
      error: `No cost column found. Header was: ${rows[0]!.join(", ")}. Use a "Cost" (or "Purchase cost" / "Landed cost") column.`,
    };
  }
  if (!headers.has("sku") && !headers.has("name")) {
    return {
      error: `Need a SKU or Name column to match products. Header was: ${rows[0]!.join(", ")}.`,
    };
  }

  // Catalogue match indexes. A SKU or name shared by more than one product is
  // marked ambiguous — never guessed.
  const skuCounts = new Map<string, number>();
  const bySku = new Map<string, MatchProduct>();
  const nameCounts = new Map<string, number>();
  const byName = new Map<string, MatchProduct>();
  for (const p of products) {
    const sk = (p.sku ?? "").trim().toLowerCase();
    if (sk) {
      skuCounts.set(sk, (skuCounts.get(sk) ?? 0) + 1);
      bySku.set(sk, p);
    }
    const nm = normName(p.title ?? "");
    if (nm) {
      nameCounts.set(nm, (nameCounts.get(nm) ?? 0) + 1);
      byName.set(nm, p);
    }
  }

  const get = (row: string[], key: "sku" | "name" | "cost") => {
    const idx = headers.get(key);
    return idx == null ? undefined : row[idx]?.trim();
  };

  const out: CostImportPreviewRow[] = [];
  const summary = { total: 0, matched: 0, pinned: 0, ambiguous: 0, unknown: 0, invalid: 0 };

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    const sku = get(row, "sku") || null;
    const name = get(row, "name") || null;
    const cost = parseCostCell(get(row, "cost"));
    const costKes = cost.cost;
    const rowNumber = i;
    summary.total++;

    const base = { rowNumber, sku, name, costKes, productId: null, title: null, pinned: false };

    if (cost.cost == null) {
      summary.invalid++;
      out.push({ ...base, status: "invalid", note: cost.note });
      continue;
    }

    const skKey = sku?.toLowerCase();
    const nmKey = name ? normName(name) : undefined;

    // Ambiguity first: a duplicate SKU/name can't be resolved deterministically.
    if (skKey && (skuCounts.get(skKey) ?? 0) > 1) {
      summary.ambiguous++;
      out.push({ ...base, status: "ambiguous", note: `SKU "${sku}" is on more than one product — give each its own SKU.` });
      continue;
    }
    const skuMatch = skKey ? bySku.get(skKey) : undefined;
    let match = skuMatch;
    if (!match && nmKey) {
      if ((nameCounts.get(nmKey) ?? 0) > 1) {
        summary.ambiguous++;
        out.push({ ...base, status: "ambiguous", note: `Name matches more than one product — match by SKU instead.` });
        continue;
      }
      match = byName.get(nmKey);
    }

    if (!match) {
      summary.unknown++;
      out.push({ ...base, status: "unknown", note: "No product with this SKU or name." });
      continue;
    }

    const pinned = match.costSource === "manual";
    summary.matched++;
    if (pinned) summary.pinned++;
    out.push({
      ...base,
      status: "matched",
      productId: match.id,
      title: match.title,
      pinned,
      note: pinned ? "Already a typed cost — kept unless you choose to overwrite." : null,
    });
  }

  return { rows: out, summary };
}

export type CostWrite = { productId: string; costKes: number };

/**
 * The write plan from a preview: matched rows only, deduped by product (first
 * row wins), with manual-pinned products excluded unless `overwritePinned`.
 * Deterministic and idempotent — applying the same preview twice writes the same
 * costs.
 */
export function applicableWrites(
  preview: CostImportPreview,
  opts: { overwritePinned?: boolean } = {},
): CostWrite[] {
  const seen = new Set<string>();
  const writes: CostWrite[] = [];
  for (const r of preview.rows) {
    if (r.status !== "matched" || r.productId == null || r.costKes == null) continue;
    if (r.pinned && !opts.overwritePinned) continue;
    if (seen.has(r.productId)) continue;
    seen.add(r.productId);
    writes.push({ productId: r.productId, costKes: r.costKes });
  }
  return writes;
}
