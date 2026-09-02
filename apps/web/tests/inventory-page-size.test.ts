import { describe, expect, it } from "vitest";
import {
  LOCATION_OPTIONAL_COLUMNS,
  LOCATION_PAGE_SIZES,
  locationsQueryToSearch,
  parseLocationsQuery,
} from "@/lib/data/stock";
import { pageBounds } from "@/lib/catalogue";

/**
 * Letting the reader choose how many lines a page holds.
 *
 * A branch with 500 lines is a scroll, and reading it 50 at a time turns
 * finding one product into a paging exercise. The size reaches a `slice()` and
 * a page count, so the set is closed: an arbitrary number from the URL is a way
 * to ask for the entire catalogue in one response.
 */

const base = { search: "", page: 0, sortKey: "onHand" as const, desc: true, hidden: [] };

describe("inventory page size", () => {
  it("accepts only the sizes on offer", () => {
    for (const size of LOCATION_PAGE_SIZES) {
      expect(parseLocationsQuery({ per: String(size) }).pageSize).toBe(size);
    }
  });

  it("refuses a size nobody offered", () => {
    // The whole point of the closed set: 100000 here is one response carrying
    // every line the workspace owns.
    for (const bad of ["100000", "0", "-50", "abc", "75"]) {
      expect(
        parseLocationsQuery({ per: bad }).pageSize,
        `the URL asked for ${bad} lines and got them`,
      ).toBe(50);
    }
  });

  it("keeps the default out of the URL", () => {
    expect(locationsQueryToSearch({ ...base, pageSize: 50 })).toBe("");
    expect(locationsQueryToSearch({ ...base, pageSize: 200 })).toBe("?per=200");
  });

  it("actually changes how many lines a page holds", () => {
    // The control has to reach the arithmetic. A picker that writes a param
    // nothing divides by looks identical to one that works.
    expect(pageBounds(500, 0, 50).pageCount).toBe(10);
    expect(pageBounds(500, 0, 200).pageCount).toBe(3);
    expect(pageBounds(500, 2, 200).start).toBe(400);
  });

  it("clamps a page past the end rather than showing nothing", () => {
    // Raising the size shrinks the page count under someone sitting on page 9.
    expect(pageBounds(500, 9, 200).current).toBe(2);
  });
});

/**
 * Hiding columns a particular shop does not use.
 *
 * The URL carries what is HIDDEN, not what is shown. A shown-list would freeze
 * the table at the moment someone first touched the control: a column added
 * later would be invisible to every one of them, and the bug reads as "the new
 * column never shipped".
 */
describe("inventory column picker", () => {
  it("carries what is hidden, so a new column appears for everyone", () => {
    const q = parseLocationsQuery({ hide: ["sku", "valueKes"] });
    expect(q.hidden).toEqual(["sku", "valueKes"]);
    // A column that did not exist when this URL was made is not in the list,
    // and therefore shows.
    expect(q.hidden).not.toContain("onOrderUnits");
  });

  it("ignores a column name nobody offered", () => {
    expect(parseLocationsQuery({ hide: ["sku", "title", "nonsense"] }).hidden).toEqual(["sku"]);
  });

  it("spells the same choice the same way", () => {
    // Fixed order, so two links to the same view compare equal rather than
    // depending on which order the reader clicked them off in.
    const a = locationsQueryToSearch({ ...base, pageSize: 50, hidden: ["valueKes", "sku"] });
    const b = locationsQueryToSearch({ ...base, pageSize: 50, hidden: ["sku", "valueKes"] });
    expect(a).toBe(b);
    expect(a).toBe("?hide=sku&hide=valueKes");
  });

  it("keeps a clean URL when every column is showing", () => {
    expect(locationsQueryToSearch({ ...base, pageSize: 50, hidden: [] })).toBe("");
  });

  it("cannot hide the product or the quantity", () => {
    // A stock table without either is not a shorter table, it is a useless one.
    expect(LOCATION_OPTIONAL_COLUMNS).not.toContain("title");
    expect(LOCATION_OPTIONAL_COLUMNS).not.toContain("onHand");
  });
});
