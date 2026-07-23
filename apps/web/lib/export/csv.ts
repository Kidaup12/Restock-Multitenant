/**
 * Pure spreadsheet-text builders for the "export what you see" suite. No DOM,
 * no dates-of-now — callers pass everything in, tests drive it directly.
 *
 * CSV follows RFC 4180: CRLF row endings, quote-wrap any cell containing a
 * quote, comma, or line break (quotes doubled inside). A UTF-8 BOM is
 * prepended by default so Excel detects the encoding instead of mangling
 * non-ASCII (product names, the KES prefix).
 *
 * Cells that a spreadsheet would execute as formulas (=, +, -, @ prefixes) are
 * neutralised with a leading apostrophe — product titles come from synced
 * catalogues, not from us, so they are untrusted input to Excel. Only string
 * cells are guarded; numbers can't be formulas, so numeric data passed as
 * numbers survives untouched.
 */

export type CellValue = string | number | boolean | null | undefined;

export type CsvOptions = {
  /** Prepend the UTF-8 BOM (Excel encoding detection). Default true. */
  bom?: boolean;
  /** Apostrophe-prefix string cells that would run as spreadsheet formulas. Default true. */
  guardFormulas?: boolean;
};

const FORMULA_PREFIXES = ["=", "+", "-", "@", "\t", "\r"];

function toText(value: CellValue, guardFormulas: boolean): string {
  if (value == null) return "";
  if (typeof value !== "string") return String(value);
  if (guardFormulas && FORMULA_PREFIXES.some((p) => value.startsWith(p))) {
    return `'${value}`;
  }
  return value;
}

function escapeCsvCell(text: string): string {
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function rowsToCsv(
  headers: readonly string[],
  rows: readonly (readonly CellValue[])[],
  options: CsvOptions = {}
): string {
  const { bom = true, guardFormulas = true } = options;
  const lines = [headers, ...rows].map((row) =>
    row.map((cell) => escapeCsvCell(toText(cell, guardFormulas))).join(",")
  );
  return (bom ? "\uFEFF" : "") + lines.join("\r\n");
}

/**
 * Tab-separated text for the clipboard — what Excel and Sheets split into
 * cells on paste. TSV has no quoting convention paste targets agree on, so
 * embedded tabs and line breaks are flattened to spaces instead.
 */
export function rowsToTsv(
  headers: readonly string[],
  rows: readonly (readonly CellValue[])[],
  options: Pick<CsvOptions, "guardFormulas"> = {}
): string {
  const { guardFormulas = true } = options;
  const lines = [headers, ...rows].map((row) =>
    row.map((cell) => toText(cell, guardFormulas).replace(/[\t\n\r]+/g, " ")).join("\t")
  );
  return lines.join("\n");
}

/** "buy-list" -> "buy-list-2026-07-23.csv" — date-stamped so repeat exports don't overwrite. */
export function timestampedFilename(base: string, extension: string, now: Date = new Date()): string {
  return `${base}-${now.toISOString().slice(0, 10)}.${extension}`;
}
