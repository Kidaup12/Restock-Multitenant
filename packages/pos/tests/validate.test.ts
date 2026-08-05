import { describe, expect, it } from "vitest";
import { validatePosSales } from "../src/validate";

/**
 * The payload gate. Before it, the route asserted only that `sales` was an
 * array and cast the rest — so a null date reached `.trim()`, a missing `lines`
 * reached a `for…of`, and the bridge got a 500 it could only answer by
 * retrying the same bad payload while the shop's till sales stayed out of
 * restock planning.
 */

const goodLine = { sku: "CAN-SHE-340", qty: 2 };
const goodSale = {
  externalId: "S1",
  date: "2026-07-15T09:00:00Z",
  lines: [goodLine],
};

const fieldsOf = (result: ReturnType<typeof validatePosSales>) =>
  result.ok ? [] : result.errors.map((e) => `${e.index}:${e.field}`);

describe("validatePosSales", () => {
  it("accepts a well-formed payload, and an empty one", () => {
    expect(validatePosSales([goodSale]).ok).toBe(true);
    expect(validatePosSales([]).ok).toBe(true);
    // A receipt that rang nothing is odd but not malformed.
    expect(validatePosSales([{ ...goodSale, lines: [] }]).ok).toBe(true);
    // A Date object is as valid as a string.
    expect(validatePosSales([{ ...goodSale, date: new Date() }]).ok).toBe(true);
  });

  it("names the row and field for every shape the issue listed", () => {
    expect(fieldsOf(validatePosSales([{ ...goodSale, date: undefined }]))).toEqual(["0:date"]);
    expect(fieldsOf(validatePosSales([{ ...goodSale, date: null }]))).toEqual(["0:date"]);
    expect(fieldsOf(validatePosSales([{ ...goodSale, date: "not a date" }]))).toEqual(["0:date"]);
    expect(fieldsOf(validatePosSales([{ ...goodSale, date: new Date("nope") }]))).toEqual(["0:date"]);
    expect(fieldsOf(validatePosSales([{ ...goodSale, lines: undefined }]))).toEqual(["0:lines"]);
    expect(fieldsOf(validatePosSales([{ ...goodSale, lines: "two" }]))).toEqual(["0:lines"]);
    expect(fieldsOf(validatePosSales([{ ...goodSale, externalId: "" }]))).toEqual(["0:externalId"]);
    expect(fieldsOf(validatePosSales([{ ...goodSale, externalId: "  " }]))).toEqual(["0:externalId"]);
    expect(fieldsOf(validatePosSales([{ ...goodSale, lines: [{ sku: "A", qty: "3" }] }]))).toEqual([
      "0:lines.0.qty",
    ]);
    expect(fieldsOf(validatePosSales([{ ...goodSale, lines: [{ qty: 1 }] }]))).toEqual([
      "0:lines.0.sku",
    ]);
    expect(fieldsOf(validatePosSales([{ ...goodSale, grandTotal: "1200" }]))).toEqual([
      "0:grandTotal",
    ]);
    expect(fieldsOf(validatePosSales(["not an object"]))).toEqual(["0:"]);
  });

  it("optional money may be absent or null, never a NaN", () => {
    expect(validatePosSales([{ ...goodSale, grandTotal: null }]).ok).toBe(true);
    expect(validatePosSales([{ ...goodSale, lines: [{ ...goodLine, price: null }] }]).ok).toBe(true);
    expect(fieldsOf(validatePosSales([{ ...goodSale, grandTotal: Number.NaN }]))).toEqual([
      "0:grandTotal",
    ]);
  });

  it("points at the offending row when only one of many is bad", () => {
    const result = validatePosSales([
      goodSale,
      { ...goodSale, externalId: "S2", date: null },
      { ...goodSale, externalId: "S3" },
    ]);
    expect(result.ok).toBe(false);
    expect(fieldsOf(result)).toEqual(["1:date"]);
  });

  it("reports every problem in a row, not just the first", () => {
    const result = validatePosSales([{ externalId: "", date: null, lines: [{ qty: "x" }] }]);
    expect(fieldsOf(result).sort()).toEqual(
      ["0:date", "0:externalId", "0:lines.0.qty", "0:lines.0.sku"].sort()
    );
  });
});
