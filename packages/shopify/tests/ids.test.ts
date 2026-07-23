import { describe, expect, it } from "vitest";
import { numericCore, toGid } from "../src/ids";

describe("numericCore", () => {
  it("strips the gid prefix down to the numeric core", () => {
    expect(numericCore("gid://shopify/Product/123")).toBe("123");
    expect(numericCore("gid://shopify/ProductVariant/456")).toBe("456");
    expect(numericCore("gid://shopify/Location/78")).toBe("78");
    expect(numericCore("gid://shopify/InventoryItem/9")).toBe("9");
  });

  it("passes bare numeric ids through", () => {
    expect(numericCore("123")).toBe("123");
  });

  it("maps mixed spellings of the same product to one key", () => {
    // The duplicate-product bug: a bare-id row and a gid row for the same
    // product must resolve to the same identity.
    expect(numericCore("gid://shopify/Product/123")).toBe(numericCore("123"));
  });

  it("leaves unrecognized strings untouched", () => {
    expect(numericCore("not-an-id")).toBe("not-an-id");
  });

  it("ignores gid query parameters", () => {
    expect(numericCore("gid://shopify/InventoryLevel/1?inventory_item_id=2")).toBe("1");
  });
});

describe("toGid", () => {
  it("builds a gid from a core", () => {
    expect(toGid("Product", "123")).toBe("gid://shopify/Product/123");
  });

  it("passes an existing gid through", () => {
    expect(toGid("Product", "gid://shopify/Product/123")).toBe("gid://shopify/Product/123");
  });

  it("round-trips with numericCore", () => {
    expect(numericCore(toGid("Location", "55"))).toBe("55");
  });
});
