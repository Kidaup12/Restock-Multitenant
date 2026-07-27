import { describe, expect, it } from "vitest";

import {
  BUYABLE_PRODUCT_WHERE,
  NOT_SELLING_STATUSES,
  heldReason,
  isBuyable,
  productLifecycle,
} from "../src/product-lifecycle";

const selling = {
  active: true,
  notForSale: false,
  shopifyStatus: "active",
  publishedAt: new Date("2026-01-01"),
  missingFromShopifyAt: null,
};

describe("productLifecycle", () => {
  it("reads a published, active product as active", () => {
    expect(productLifecycle(selling)).toBe("active");
    expect(isBuyable(selling)).toBe(true);
    expect(heldReason(selling)).toBeNull();
  });

  it("calls an unpublished product unlisted but still buys it", () => {
    const row = { ...selling, publishedAt: null };
    expect(productLifecycle(row)).toBe("unlisted");
    // The shop that sells over the counter and never publishes to the online
    // store still needs a buy list. Unlisted is a label, not an exclusion.
    expect(isBuyable(row)).toBe(true);
    expect(heldReason(row)).toBeNull();
  });

  it.each(["draft", "archived"])("holds a %s product off the buy list", (status) => {
    const row = { ...selling, shopifyStatus: status };
    expect(isBuyable(row)).toBe(false);
    expect(heldReason(row)).not.toBeNull();
  });

  it("reports removal ahead of archival, because that is the one to act on", () => {
    const row = { ...selling, shopifyStatus: "archived", missingFromShopifyAt: new Date() };
    expect(productLifecycle(row)).toBe("removed");
    expect(heldReason(row)).toContain("nothing to plan");
  });

  it("holds a product that vanished from the store even while it still reads active", () => {
    const row = { ...selling, missingFromShopifyAt: new Date() };
    expect(productLifecycle(row)).toBe("removed");
    expect(isBuyable(row)).toBe(false);
  });

  it("keeps the owner's not-for-sale and deactivated flags working", () => {
    expect(productLifecycle({ ...selling, notForSale: true })).toBe("not_for_sale");
    expect(productLifecycle({ ...selling, active: false })).toBe("deactivated");
    expect(isBuyable({ ...selling, notForSale: true })).toBe(false);
    expect(isBuyable({ ...selling, active: false })).toBe(false);
  });

  it("lets the store's word beat the owner's flag in the label", () => {
    // Both are true; the owner needs to know the store archived it, because
    // clearing not-for-sale alone will not bring it back.
    const row = { ...selling, notForSale: true, shopifyStatus: "archived" };
    expect(productLifecycle(row)).toBe("archived");
  });
});

describe("BUYABLE_PRODUCT_WHERE", () => {
  it("matches isBuyable field for field", () => {
    expect(BUYABLE_PRODUCT_WHERE.active).toBe(true);
    expect(BUYABLE_PRODUCT_WHERE.notForSale).toBe(false);
    expect(BUYABLE_PRODUCT_WHERE.missingFromShopifyAt).toBeNull();
    expect(BUYABLE_PRODUCT_WHERE.shopifyStatus.notIn).toEqual(NOT_SELLING_STATUSES);
  });

  it("does not filter on publishedAt", () => {
    // A notIn/equals on publishedAt here would silently empty the buy list of
    // any shop that keeps its catalogue unpublished.
    expect(Object.keys(BUYABLE_PRODUCT_WHERE)).not.toContain("publishedAt");
  });
});
