import { describe, expect, it } from "vitest";
import { inventoryExportColumns } from "@/app/(shell)/inventory/inventory-export";

/**
 * The file a stock count is done from.
 *
 * Inventory was the one screen with no way to get its numbers out of the
 * browser, which is the screen most likely to be printed and walked around a
 * shop with. Two things have to hold: the branch is on every row, and a
 * money-blind member's file carries no value.
 */

describe("inventory export", () => {
  it("leads every row with the branch", () => {
    // A file of SKUs with no branch is unusable the moment a shop has two.
    expect(inventoryExportColumns(true, "KES")[0]!.header).toBe("Branch");
  });

  it("carries the value only for a reader who can see costs", () => {
    const member = inventoryExportColumns(false, "KES").map((c) => c.header);
    const owner = inventoryExportColumns(true, "KES").map((c) => c.header);
    expect(member, "a money-blind member's export carries stock value").not.toContain("Value (KES)");
    expect(owner).toContain("Value (KES)");
  });

  it("labels the money in the workspace's own currency", () => {
    expect(inventoryExportColumns(true, "UGX").map((c) => c.header)).toContain("Value (UGX)");
  });

  it("names the shop-wide columns as shop-wide", () => {
    // Cover and en route are whole-shop figures, not per-branch ones. A column
    // called "Days cover" beside a branch name would be read as that branch's.
    const headers = inventoryExportColumns(true, "KES").map((c) => c.header);
    expect(headers).toContain("Days cover (shop)");
    expect(headers).toContain("En route (shop)");
  });
});
