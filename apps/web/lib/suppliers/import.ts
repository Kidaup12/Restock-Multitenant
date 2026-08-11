/**
 * Supplier CSV import — day one for a shop with forty suppliers on a spreadsheet.
 *
 * Same shape as the cost import: paste or drop a file → a DETERMINISTIC preview
 * (create / update / invalid / repeat) → apply. Nothing is written until apply,
 * and apply re-runs this same preview server-side so it can never act on a plan
 * the browser edited.
 *
 * This module is pure: it parses the text and decides each row against the
 * suppliers the caller loads. The write lives in the server action.
 *
 * Rows are validated, not coerced. A blank lead time stays blank — the forecast
 * reads Supplier.leadTimeAvgDays directly, so inventing a default here would put
 * a number nobody typed behind every reorder point.
 */
import { normName, parseDelimited } from "@/lib/cost";

/** Same set the hand-add form accepts (suppliers/actions.ts). */
export const IMPORT_CURRENCIES = ["KES", "USD", "CNY", "AED"] as const;

/** One call's ceiling. Well past a real supplier list, small enough that a
 *  malformed paste can't rewrite the book. */
export const IMPORT_ROW_MAX = 500;

type Field =
  | "name"
  | "email"
  | "country"
  | "currency"
  | "supplierGroup"
  | "leadTimeAvgDays"
  | "leadTimeStdDays"
  | "moq"
  | "notes";

const HEADER_ALIASES: Record<Field, string[]> = {
  name: ["name", "supplier", "supplier name", "vendor", "company", "display name"],
  email: ["email", "e mail", "contact email", "contact"],
  country: ["country", "origin"],
  currency: ["currency", "ccy", "currency code"],
  supplierGroup: ["group", "supplier group", "category", "tag"],
  leadTimeAvgDays: [
    "lead time",
    "lead time days",
    "lead time avg days",
    "lead days",
    "avg lead time",
    "average lead time",
    "leadtimeavgdays",
  ],
  leadTimeStdDays: [
    "lead time variability",
    "lead time std days",
    "lead std",
    "lead time std",
    "variability",
    "leadtimestddays",
  ],
  moq: ["moq", "minimum order", "min order", "minimum order quantity", "min qty"],
  notes: ["notes", "note", "comment", "comments"],
};

const FIELDS = Object.keys(HEADER_ALIASES) as Field[];

/** Longest alias first, so "lead time std days" is not claimed by "lead time". */
function mapHeaders(headerRow: string[]): Map<Field, number> {
  const map = new Map<Field, number>();
  const norms = headerRow.map((h) =>
    h.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ")
  );
  const claimed = new Set<number>();
  const candidates = FIELDS.flatMap((field) =>
    HEADER_ALIASES[field].map((alias) => ({ field, alias }))
  ).sort((a, b) => b.alias.length - a.alias.length);
  for (const { field, alias } of candidates) {
    if (map.has(field)) continue;
    const idx = norms.findIndex((n, i) => !claimed.has(i) && n === alias);
    if (idx >= 0) {
      map.set(field, idx);
      claimed.add(idx);
    }
  }
  return map;
}

export type ImportSupplier = {
  id: string;
  name: string;
};

export type SupplierRowStatus = "create" | "update" | "invalid" | "repeat";

export type SupplierImportRow = {
  /** 1-based data-row number (header excluded). */
  rowNumber: number;
  name: string | null;
  status: SupplierRowStatus;
  /** Set when the row matched an existing supplier (status "update"). */
  supplierId: string | null;
  /** The values that would be written. Null on an invalid row. */
  data: SupplierWriteData | null;
  /** Why the row can't be applied, or what the match was. */
  note: string | null;
};

/**
 * What one row asks for. Every optional field is null when the file didn't give
 * it — the caller decides what a missing value means, and for an existing
 * supplier that means "leave what's there alone". An import that happens not to
 * carry an email column must not wipe every email in the book.
 */
export type SupplierWriteData = {
  name: string;
  email: string | null;
  country: string | null;
  /** null when the file gave no currency — the workspace default fills in on create. */
  currency: string | null;
  supplierGroup: string | null;
  notes: string | null;
  leadTimeAvgDays: number | null;
  leadTimeStdDays: number | null;
  moq: number | null;
};

export type SupplierImportPreview = {
  rows: SupplierImportRow[];
  summary: { total: number; create: number; update: number; invalid: number; repeat: number };
};

export type SupplierImportError = { error: string };

/**
 * Classify every row against the tenant's live suppliers.
 *
 * Matching is on the normalised name and nothing else — `Supplier` carries no
 * unique constraint, so there is no key to upsert on and a guessed match would
 * silently overwrite the wrong supplier's lead time.
 *
 * Pass only LIVE suppliers: a soft-deleted row must not be matched, or an import
 * would quietly resurrect a supplier the owner removed.
 */
export function previewSupplierImport(
  text: string,
  existing: ImportSupplier[]
): SupplierImportPreview | SupplierImportError {
  const rows = parseDelimited(text);
  if (rows.length < 2) return { error: "Add a header row plus at least one supplier row." };

  const headers = mapHeaders(rows[0]!);
  if (!headers.has("name")) {
    return {
      error: `No supplier-name column found. Header was: ${rows[0]!.join(", ")}. Use a "Name" (or "Supplier" / "Vendor") column.`,
    };
  }
  const dataRows = rows.length - 1;
  if (dataRows > IMPORT_ROW_MAX) {
    return { error: `That file has ${dataRows} rows — import up to ${IMPORT_ROW_MAX} at a time.` };
  }

  // One index, seeded with what's already saved and grown as the file is read,
  // so the second "Acme Ltd" in the same file updates the first rather than
  // creating a twin the owner then has to merge by hand.
  const byName = new Map<string, string | null>();
  for (const s of existing) {
    const key = normName(s.name);
    if (key) byName.set(key, s.id);
  }
  const seenInFile = new Set<string>();

  const get = (row: string[], key: Field) => {
    const idx = headers.get(key);
    return idx == null ? undefined : row[idx]?.trim();
  };

  const out: SupplierImportRow[] = [];
  const summary = { total: 0, create: 0, update: 0, invalid: 0, repeat: 0 };

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    const rowNumber = i;
    summary.total++;
    const rawName = get(row, "name") ?? "";
    const name = rawName.trim();

    const invalid = (note: string): void => {
      summary.invalid++;
      out.push({ rowNumber, name: name || null, status: "invalid", supplierId: null, data: null, note });
    };

    if (!name) {
      invalid("No supplier name in this row.");
      continue;
    }
    if (name.length > 200) {
      invalid("Supplier name is too long (200 characters max).");
      continue;
    }

    const currencyCell = get(row, "currency");
    const currency = currencyCell ? normaliseCurrency(currencyCell) : null;
    if (currencyCell && !currency) {
      invalid(`Currency "${currencyCell}" isn't one of ${IMPORT_CURRENCIES.join(", ")}.`);
      continue;
    }

    const lead = parseIntCell(get(row, "leadTimeAvgDays"), 0, 365);
    if (lead.error) {
      invalid(`Lead time ${lead.error}`);
      continue;
    }
    const std = parseIntCell(get(row, "leadTimeStdDays"), 0, 180);
    if (std.error) {
      invalid(`Lead-time variability ${std.error}`);
      continue;
    }
    const moq = parseIntCell(get(row, "moq"), 1, 1_000_000);
    if (moq.error) {
      invalid(`Minimum order quantity ${moq.error}`);
      continue;
    }

    const data: SupplierWriteData = {
      name,
      email: emptyToNull(get(row, "email")),
      country: emptyToNull(get(row, "country")),
      currency,
      supplierGroup: emptyToNull(get(row, "supplierGroup")),
      notes: emptyToNull(get(row, "notes")),
      leadTimeAvgDays: lead.value,
      leadTimeStdDays: std.value,
      moq: moq.value,
    };

    const key = normName(name);
    if (byName.has(key)) {
      const supplierId = byName.get(key) ?? null;
      // Already written by an earlier row of THIS file — whether that row
      // created the supplier or updated an existing one. Applying both would
      // write the same supplier twice, and the second set of values would
      // silently win over the first.
      if (seenInFile.has(key)) {
        summary.repeat++;
        out.push({
          rowNumber,
          name,
          status: "repeat",
          supplierId,
          data,
          note: "Same supplier appears earlier in this file — the first row wins.",
        });
        continue;
      }
      seenInFile.add(key);
      summary.update++;
      out.push({
        rowNumber,
        name,
        status: "update",
        supplierId,
        data,
        note: "Matches a supplier you already have — its details will be updated.",
      });
      continue;
    }

    byName.set(key, null);
    seenInFile.add(key);
    summary.create++;
    out.push({ rowNumber, name, status: "create", supplierId: null, data, note: null });
  }

  return { rows: out, summary };
}

export type SupplierWrite =
  | { kind: "create"; data: SupplierWriteData }
  | { kind: "update"; supplierId: string; data: SupplierWriteData };

/**
 * The write plan from a preview: creates and updates in file order, repeats and
 * invalid rows dropped. Deterministic — applying the same file twice is a set of
 * updates with the same values, never a second copy of anything.
 */
export function applicableSupplierWrites(preview: SupplierImportPreview): SupplierWrite[] {
  const writes: SupplierWrite[] = [];
  for (const r of preview.rows) {
    if (!r.data) continue;
    if (r.status === "create") writes.push({ kind: "create", data: r.data });
    else if (r.status === "update" && r.supplierId) {
      writes.push({ kind: "update", supplierId: r.supplierId, data: r.data });
    }
  }
  return writes;
}

/** The header row we hand out as a template, in the order the form asks for it. */
export const TEMPLATE_HEADERS = [
  "Name",
  "Email",
  "Country",
  "Currency",
  "Group",
  "Lead time",
  "Lead time variability",
  "MOQ",
  "Notes",
];

function normaliseCurrency(raw: string | null | undefined): string | null {
  const code = raw?.trim().toUpperCase();
  if (!code) return null;
  return (IMPORT_CURRENCIES as readonly string[]).includes(code) ? code : null;
}

function emptyToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * A blank cell means "not given" (null), not zero — the whole point of leaving
 * lead time unset is that the engine falls back to category timing rather than
 * ordering as if the goods arrive today.
 */
function parseIntCell(
  raw: string | undefined,
  min: number,
  max: number
): { value: number | null; error: null } | { value: null; error: string } {
  const text = (raw ?? "").trim();
  if (text === "") return { value: null, error: null };
  const digits = text.replace(/,/g, "");
  if (!/^[0-9]+(\.0+)?$/.test(digits)) {
    return { value: null, error: `"${text}" isn't a whole number.` };
  }
  const n = Math.round(Number.parseFloat(digits));
  if (!Number.isFinite(n)) return { value: null, error: `"${text}" isn't a whole number.` };
  if (n < min || n > max) return { value: null, error: `should be between ${min} and ${max}.` };
  return { value: n, error: null };
}
