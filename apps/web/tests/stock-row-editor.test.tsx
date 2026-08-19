import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { CatalogueRow } from "@/lib/data/stock";

/**
 * What the expanding row editor actually renders for each role. The controls
 * themselves are server actions with their own suite; this covers the surface a
 * reviewer clicks: that archive / restore / keep-active offer the right one of
 * the pair for the row's state, and that a money-blind member gets no price
 * field — a price editor is a margin editor.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

const { RowEditor } = await import("../app/(shell)/products/row-editor");

const row: CatalogueRow = {
  productId: "p1",
  sku: "ROW-1",
  title: "Editor Fixture",
  variantTitle: null,
  shopifyProductId: null,
  vendor: "Fixture Co",
  onHandUnits: 5,
  warehouseUnits: 0,
  daysCover: 12,
  urgency: null,
  priceKes: 799.5,
  runRate: 0.4,
  revenue30dKes: 3200,
  costKes: 400,
  stockValueKes: 2000,
  moneyAtRestKes: 2000,
  abc: "B",
  customCategory: "Skin",
  costSource: "manual",
  notForSale: false,
  lifecycle: "active",
  lifecycleLabel: "Active",
  buyable: true,
  lifecycleReason: null,
  onOrderUnits: 0,
  expectedArrivalAt: null,
  syncError: null,
  syncErrorAt: null,
  leadDays: 14,
  verdict: "healthy",
  marginPct: 50,
  missingCost: false,
  suspectCost: false,
  heldOffBuyList: false,
  costMovedPct: null,
  costMovedAt: null,
  // The editor never reads the facet projection; it is here to satisfy the row.
  facet: {
    productId: "p1",
    brand: "Fixture Co",
    productType: null,
    category: "Skin",
    supplier: null,
    supplierGroup: null,
    speedBand: null,
    abc: "B",
    health: [],
  },
};

const render = (props: Partial<Parameters<typeof RowEditor>[0]>) =>
  renderToStaticMarkup(
    <RowEditor
      row={row}
      categories={["Skin"]}
      flags={{ active: true, activeOverride: false }}
      canViewCosts
      canManage
      {...props}
    />,
  );

describe("catalogue row editor", () => {
  it("offers Archive on a live row and Restore on an archived one — never both", () => {
    const live = render({});
    expect(live).toContain("Archive");
    expect(live).not.toContain("Restore");

    const archived = render({ flags: { active: false, activeOverride: false } });
    expect(archived).toContain("Restore");
    expect(archived).toContain("Archived by you");
  });

  it("shows the keep-active state instead of offering it again", () => {
    const pinned = render({ flags: { active: true, activeOverride: true } });
    expect(pinned).toContain("Kept active");
    expect(pinned).toContain("won&#x27;t retire it");
  });

  it("says plainly that a typed price does not pin", () => {
    const html = render({});
    expect(html).toContain("Selling price");
    expect(html).toContain("Save price");
    expect(html).toContain("the next catalogue sync brings its price back");
  });

  it("gives a money-blind member no price field and no cost field", () => {
    const html = render({ canViewCosts: false });
    expect(html).not.toContain("Save price");
    expect(html).not.toContain("Pin cost");
    expect(html).toContain("Editing the price needs cost access.");
  });

  it("offers no owner switches at all without settings access", () => {
    const html = render({ canManage: false });
    expect(html).toContain("You need settings access to edit this product.");
    expect(html).not.toContain("Archive");
    expect(html).not.toContain("Keep active");
    expect(html).not.toContain("Save price");
  });
});
