import { describe, expect, it } from "vitest";
import { normalizeShopDomain } from "../lib/shopify/shop-domain";

/**
 * Connecting a store is a first-run step, and the obvious move is to copy the
 * URL out of the browser. Every one of these forms used to be passed through
 * untouched and rejected by the install route as an invalid domain — a raw 400
 * JSON page on the screen that matters most.
 */

describe("normalizeShopDomain", () => {
  it("accepts the forms a merchant actually pastes", () => {
    const want = "my-store.myshopify.com";
    for (const input of [
      "my-store",
      "my-store.myshopify.com",
      "My-Store.MyShopify.com",
      "  my-store.myshopify.com  ",
      "my-store.myshopify.com/",
      "my-store.myshopify.com/admin",
      "https://my-store.myshopify.com",
      "https://my-store.myshopify.com/admin",
      "https://my-store.myshopify.com/admin/products?foo=1",
      "http://www.my-store.myshopify.com",
      // The URL the newer Shopify admin shows.
      "https://admin.shopify.com/store/my-store",
      "admin.shopify.com/store/my-store/products",
    ]) {
      expect(normalizeShopDomain(input), input).toBe(want);
    }
  });

  it("rejects what is not a store address, rather than passing it on", () => {
    for (const input of ["", "   ", "https://", "not a domain", "shop.example.com", "-bad.myshopify.com", "my_store"]) {
      expect(normalizeShopDomain(input), input).toBeNull();
    }
  });
});
