import { describe, expect, it } from "vitest";
import { rowsToCsv, rowsToTsv, timestampedFilename } from "../lib/export/csv";

/** Pure builders — no DOM, no db. */

const HEADERS = ["SKU", "Product", "Qty"];

describe("rowsToCsv", () => {
  it("joins headers and rows with CRLF and commas", () => {
    const csv = rowsToCsv(HEADERS, [["A-1", "Soap", 4]], { bom: false });
    expect(csv).toBe("SKU,Product,Qty\r\nA-1,Soap,4");
  });

  it("prefixes the UTF-8 BOM by default and skips it when disabled", () => {
    expect(rowsToCsv(HEADERS, []).charCodeAt(0)).toBe(0xfeff);
    expect(rowsToCsv(HEADERS, [], { bom: false }).charCodeAt(0)).not.toBe(0xfeff);
  });

  it("quotes cells containing commas, quotes, and newlines; doubles inner quotes", () => {
    const csv = rowsToCsv(
      ["a", "b", "c", "d"],
      [['say "hi"', "one,two", "line\nbreak", "cr\rcell"]],
      { bom: false, guardFormulas: false }
    );
    const [, row] = csv.split("\r\n");
    expect(row).toBe('"say ""hi""","one,two","line\nbreak","cr\rcell"');
  });

  it("renders null/undefined as empty cells and keeps numbers/booleans bare", () => {
    const csv = rowsToCsv(["a", "b", "c", "d"], [[null, undefined, 0, false]], { bom: false });
    expect(csv.split("\r\n")[1]).toBe(",,0,false");
  });

  it("neutralises formula-prefixed strings but never touches numbers", () => {
    const csv = rowsToCsv(
      ["a", "b", "c"],
      [["=SUM(A1:A9)", "@import", -42]],
      { bom: false }
    );
    expect(csv.split("\r\n")[1]).toBe("'=SUM(A1:A9),'@import,-42");
  });

  it("can disable the formula guard", () => {
    const csv = rowsToCsv(["a"], [["=A1"]], { bom: false, guardFormulas: false });
    expect(csv.split("\r\n")[1]).toBe("=A1");
  });

  it("handles non-ASCII content unchanged", () => {
    const csv = rowsToCsv(["Product"], [["Chébé Butter 250g"]], { bom: false });
    expect(csv.split("\r\n")[1]).toBe("Chébé Butter 250g");
  });
});

describe("rowsToTsv", () => {
  it("joins with tabs and LF, no BOM", () => {
    const tsv = rowsToTsv(HEADERS, [["A-1", "Soap", 4]]);
    expect(tsv).toBe("SKU\tProduct\tQty\nA-1\tSoap\t4");
    expect(tsv.charCodeAt(0)).not.toBe(0xfeff);
  });

  it("flattens tabs and line breaks inside cells to spaces", () => {
    const tsv = rowsToTsv(["a"], [["two\twords\r\nsecond line"]]);
    expect(tsv.split("\n")[1]).toBe("two words second line");
  });

  it("applies the formula guard to pasted cells too", () => {
    const tsv = rowsToTsv(["a"], [["=2+2"]]);
    expect(tsv.split("\n")[1]).toBe("'=2+2");
  });
});

describe("timestampedFilename", () => {
  it("date-stamps the base name", () => {
    const name = timestampedFilename("buy-list", "csv", new Date("2026-07-23T10:00:00Z"));
    expect(name).toBe("buy-list-2026-07-23.csv");
  });
});
