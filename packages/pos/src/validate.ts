import type { PosSaleInput } from "./types";

/**
 * Check a POS payload before anything touches it.
 *
 * The route used to assert only that `sales` was an array and cast the rest, so
 * a null date reached `value.trim()`, a missing `lines` reached a `for…of`, and
 * the request came back as a 500. A POS bridge cannot act on that: it retries
 * the same bad payload, and meanwhile the shop's till sales never reach restock
 * planning at all.
 *
 * Rejects the request rather than ingesting the good rows and dropping the bad
 * ones. Silent partial loss is worse here than a loud failure — missing
 * receipts skew the run rate, and nothing on any screen would say why.
 */

export type PosValidationError = {
  /** Index in the submitted `sales` array. */
  index: number;
  /** Dotted path to the offending field, e.g. "lines.2.qty". */
  field: string;
  message: string;
};

export type PosValidationResult =
  | { ok: true; sales: PosSaleInput[] }
  | { ok: false; errors: PosValidationError[] };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

/** A usable timestamp: a real Date, or a string a parser could read. */
function dateProblem(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "is an invalid Date" : null;
  }
  if (!isNonEmptyString(value)) return "must be a date string or a Date";
  return Number.isNaN(new Date(value).getTime()) ? `is not a readable date (${value})` : null;
}

/** Optional numeric fields may be absent or null, never a string or NaN. */
function optionalNumberProblem(value: unknown): string | null {
  if (value == null) return null;
  return typeof value === "number" && Number.isFinite(value) ? null : "must be a number";
}

export function validatePosSales(sales: unknown[]): PosValidationResult {
  const errors: PosValidationError[] = [];
  const add = (index: number, field: string, message: string) =>
    errors.push({ index, field, message });

  sales.forEach((raw, index) => {
    if (!isObject(raw)) {
      add(index, "", "must be an object");
      return;
    }

    if (!isNonEmptyString(raw.externalId)) add(index, "externalId", "is required");

    const dateIssue = dateProblem(raw.date);
    if (dateIssue) add(index, "date", dateIssue);

    const totalIssue = optionalNumberProblem(raw.grandTotal);
    if (totalIssue) add(index, "grandTotal", totalIssue);

    if (!Array.isArray(raw.lines)) {
      add(index, "lines", "must be an array");
      return;
    }

    raw.lines.forEach((line, i) => {
      if (!isObject(line)) {
        add(index, `lines.${i}`, "must be an object");
        return;
      }
      if (!isNonEmptyString(line.sku)) add(index, `lines.${i}.sku`, "is required");
      if (typeof line.qty !== "number" || !Number.isFinite(line.qty)) {
        add(index, `lines.${i}.qty`, "must be a number");
      }
      for (const field of ["price", "subtotal"] as const) {
        const issue = optionalNumberProblem(line[field]);
        if (issue) add(index, `lines.${i}.${field}`, issue);
      }
    });
  });

  return errors.length > 0 ? { ok: false, errors } : { ok: true, sales: sales as PosSaleInput[] };
}
