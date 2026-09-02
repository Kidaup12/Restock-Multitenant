import { describe, expect, it } from "vitest";
import {
  LOCATION_SORT_KEYS,
  compareLocationLines,
  parseLocationsQuery,
  type LocationLine,
} from "@/lib/data/stock";

/**
 * Sorting the inventory table.
 *
 * The reference build says "Click a column to sort" on this screen; ours had no
 * sorting at all, so on a 500-SKU catalogue the only way to reach a line was to
 * search for it by name — which assumes you already know what you are looking
 * for. Sorting is how you find what you did not know to look for.
 *
 * The rule worth testing hardest is nulls. A line with no cover figure is not
 * "the lowest cover"; it is unknown. Floating it to the top of an ascending
 * sort would put the least informative rows exactly where the most urgent
 * belong — the screen would look like it was answering the question while
 * hiding the answer.
 */

const line = (over: Partial<LocationLine> = {}): LocationLine =>
  ({
    productId: "p1",
    sku: "SKU-1",
    title: "A product",
    onHand: 10,
    valueKes: 100,
    daysCover: 30,
    oversold: false,
    onOrderUnits: 0,
    expectedArrivalAt: null,
    ...over,
  }) as LocationLine;

const order = (lines: LocationLine[], key: Parameters<typeof compareLocationLines>[2], desc: boolean) =>
  [...lines].sort((a, b) => compareLocationLines(a, b, key, desc)).map((l) => l.sku);

describe("inventory column sorting", () => {
  it("orders numbers both ways", () => {
    const lines = [
      line({ sku: "LOW", onHand: 1 }),
      line({ sku: "HIGH", onHand: 99 }),
      line({ sku: "MID", onHand: 50 }),
    ];
    expect(order(lines, "onHand", true)).toEqual(["HIGH", "MID", "LOW"]);
    expect(order(lines, "onHand", false)).toEqual(["LOW", "MID", "HIGH"]);
  });

  it("sinks unknown values in BOTH directions", () => {
    // The one that matters. A null cover must never lead an ascending sort.
    const lines = [
      line({ sku: "KNOWN-30", daysCover: 30 }),
      line({ sku: "UNKNOWN", daysCover: null }),
      line({ sku: "KNOWN-2", daysCover: 2 }),
    ];
    expect(order(lines, "daysCover", false), "an unknown cover led the urgent end").toEqual([
      "KNOWN-2",
      "KNOWN-30",
      "UNKNOWN",
    ]);
    expect(order(lines, "daysCover", true)).toEqual(["KNOWN-30", "KNOWN-2", "UNKNOWN"]);
  });

  it("sinks a redacted value too, rather than reading it as zero", () => {
    // valueKes is null for a member who cannot view costs. Treating that as 0
    // would sort their whole catalogue into a fake order.
    const lines = [
      line({ sku: "SEEN", valueKes: 500 }),
      line({ sku: "REDACTED", valueKes: null }),
    ];
    expect(order(lines, "valueKes", false)).toEqual(["SEEN", "REDACTED"]);
    expect(order(lines, "valueKes", true)).toEqual(["SEEN", "REDACTED"]);
  });

  it("orders text alphabetically, not by code point", () => {
    const lines = [line({ sku: "b", title: "Zebra" }), line({ sku: "a", title: "apple" })];
    // localeCompare, so "apple" precedes "Zebra" — a byte comparison would not.
    expect(order(lines, "title", false)).toEqual(["a", "b"]);
  });

  it("falls back to the default on a hand-edited URL rather than throwing", () => {
    expect(parseLocationsQuery({ lsort: "nonsense" }).sortKey).toBe("onHand");
    expect(parseLocationsQuery({}).sortKey).toBe("onHand");
    expect(parseLocationsQuery({ lsort: "daysCover" }).sortKey).toBe("daysCover");
  });

  it("defaults to most-stock-first, which is what the screen showed before", () => {
    // Turning sorting on must not silently rearrange anyone's existing view.
    const q = parseLocationsQuery({});
    expect(q.sortKey).toBe("onHand");
    expect(q.desc).toBe(true);
  });

  it("uses its own URL params, not the catalogue's", () => {
    // A link copied between Products and Inventory must not silently mean
    // something else: the two screens do not share columns.
    expect(parseLocationsQuery({ sort: "daysCover" }).sortKey).toBe("onHand");
    expect(parseLocationsQuery({ lsort: "daysCover" }).sortKey).toBe("daysCover");
  });

  it("offers only columns the table actually shows", () => {
    expect([...LOCATION_SORT_KEYS]).toEqual([
      "title",
      "sku",
      "onHand",
      "daysCover",
      "onOrderUnits",
      "valueKes",
    ]);
  });
});
