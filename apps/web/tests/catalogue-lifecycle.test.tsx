import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prismaService } from "@wezesha/db";
import { seedDev, type SeedResult } from "../../../packages/db/scripts/seed-dev";
import { getStockCatalogue, type CatalogueRow } from "../lib/data/stock";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

import { CatalogueTable } from "../app/(shell)/stock/catalogue-table";
import { inScope, SCOPE_LABELS } from "../app/(shell)/stock/catalogue-view";

/**
 * Product lifecycle on the catalogue screen. The rule the shop cares about is
 * that a SKU it stopped selling stays visible and filterable — archiving in
 * Shopify must not make stock and cash disappear from the screen — while the
 * day-to-day view stays about what is still selling.
 *
 * Fixtures are added on top of the seeded catalogue (which is all healthy,
 * selling product) and removed again, so the suite proves behaviour the seed
 * alone cannot show.
 *
 * Skips when no local database is configured.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const ARCHIVED_SKU = "LC-ARCHIVED";
const DRAFT_SKU = "LC-DRAFT";
const REMOVED_SKU = "LC-REMOVED";
const SYNC_SKU = "LC-SYNCFAIL";
const INBOUND_SKU = "LC-INBOUND";
const VARIANT_SKUS = ["LC-LIP-03", "LC-LIP-07"];
const FIXTURE_SKUS = [ARCHIVED_SKU, DRAFT_SKU, REMOVED_SKU, SYNC_SKU, INBOUND_SKU, ...VARIANT_SKUS];

const SYNC_MESSAGE = "Shopify rejected the variant update";
const VARIANT_GROUP = "lifecycle-variant-group";
const INBOUND_UNITS = 24;
const INBOUND_ETA = new Date(Date.UTC(2031, 4, 18));

/** The ETA form the row renders (same locale call as the column). */
const etaLabel = INBOUND_ETA.toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** Chip labels reach the markup HTML-escaped ("Archived & removed"). */
const asMarkup = (label: string) => label.replace(/&/g, "&amp;");

/** Every "KES <digits>" occurrence — a real money figure reaching the markup. */
const kesDigits = (html: string) => html.match(/KES\s[\d][\d,.]*/g) ?? [];
const MASK = "KES •••";

let seeded: SeedResult;
let rows: CatalogueRow[];
const rowBySku = (sku: string) => rows.find((r) => r.sku === sku)!;

describe.skipIf(!runnable)("product lifecycle on the catalogue (seeded local db)", () => {
  beforeAll(async () => {
    seeded = await seedDev();
    const base = { tenantId: seeded.tenantId, vendor: "Lifecycle Co", productType: "Makeup", priceKes: 1000, costKes: 400, costSource: "manual" as const, publishedAt: new Date() };
    await prismaService.product.createMany({
      data: [
        { ...base, sku: ARCHIVED_SKU, title: "Retired Balm", shopifyStatus: "archived", currentStock: 12 },
        { ...base, sku: DRAFT_SKU, title: "Unreleased Serum", shopifyStatus: "draft", currentStock: 3 },
        { ...base, sku: REMOVED_SKU, title: "Vanished Cleanser", missingFromShopifyAt: new Date(), currentStock: 7 },
        { ...base, sku: SYNC_SKU, title: "Stuck Mascara", currentStock: 5, syncError: SYNC_MESSAGE, syncErrorAt: new Date() },
        { ...base, sku: INBOUND_SKU, title: "Empty Shelf Toner", currentStock: 0, onOrder: INBOUND_UNITS, expectedArrivalAt: INBOUND_ETA },
        { ...base, sku: VARIANT_SKUS[0]!, title: "Velvet Lipstick", variantTitle: "Shade 03", shopifyProductId: VARIANT_GROUP, currentStock: 9 },
        { ...base, sku: VARIANT_SKUS[1]!, title: "Velvet Lipstick", variantTitle: "Shade 07", shopifyProductId: VARIANT_GROUP, currentStock: 4 },
      ],
    });
    rows = await getStockCatalogue(seeded.tenantId, { canViewCosts: true });
  }, 120_000);

  afterAll(async () => {
    await prismaService.product.deleteMany({
      where: { tenantId: seeded.tenantId, sku: { in: FIXTURE_SKUS } },
    });
    await prismaService.$disconnect();
  });

  it("loads products the shop stopped selling instead of hiding them", async () => {
    expect(rows).toHaveLength(seeded.productCount + FIXTURE_SKUS.length);

    expect(rowBySku(ARCHIVED_SKU).lifecycle).toBe("archived");
    expect(rowBySku(DRAFT_SKU).lifecycle).toBe("draft");
    expect(rowBySku(REMOVED_SKU).lifecycle).toBe("removed");
    for (const sku of [ARCHIVED_SKU, DRAFT_SKU, REMOVED_SKU]) {
      expect(rowBySku(sku).buyable).toBe(false);
    }

    // Their stock still reads true — the point of keeping them on screen.
    expect(rowBySku(ARCHIVED_SKU).onHandUnits).toBe(12);
    // ...and no cover verdict, because there is nothing to re-order.
    expect(rowBySku(ARCHIVED_SKU).verdict).toBeNull();
    expect(rowBySku(ARCHIVED_SKU).daysCover).toBeNull();
  });

  it("a row that is off the buy list says why, in the owner's words", () => {
    expect(rowBySku(REMOVED_SKU).lifecycleReason).toBe(
      "Gone from your store, so there is nothing to plan for it"
    );
    expect(rowBySku(ARCHIVED_SKU).lifecycleReason).toBe("Archived in your store");
    expect(rowBySku(DRAFT_SKU).lifecycleReason).toBe("Still a draft in your store");
    // A live row carries no reason — the field is the exception, not decoration.
    expect(rowBySku(SYNC_SKU).lifecycleReason).toBeNull();
  });

  it("the scope split is exclusive: selling by default, the rest under its own chip", () => {
    const selling = rows.filter((r) => inScope(r, "selling"));
    const notSelling = rows.filter((r) => inScope(r, "not_selling"));

    expect(selling.length + notSelling.length).toBe(rows.length);
    expect(rows.filter((r) => inScope(r, "all"))).toHaveLength(rows.length);
    expect(notSelling.map((r) => r.sku).sort()).toEqual([ARCHIVED_SKU, DRAFT_SKU, REMOVED_SKU].sort());
    // Everything the seed ships is still selling — the default view is unchanged
    // by this feature for a healthy catalogue.
    expect(selling.length).toBe(seeded.productCount + 4);
  });

  it("the default view excludes them while the scope chips show they exist", async () => {
    const html = renderToStaticMarkup(
      await CatalogueTable({ tenantId: seeded.tenantId, canViewCosts: true })
    );

    for (const sku of [ARCHIVED_SKU, DRAFT_SKU, REMOVED_SKU]) {
      expect(html).not.toContain(sku);
    }
    expect(html).toContain(SYNC_SKU); // still selling, so still in the default view

    // The chips are the way back to them: labelled and counted, never absent.
    expect(html).toContain(asMarkup(SCOPE_LABELS.selling));
    expect(html).toContain(asMarkup(SCOPE_LABELS.not_selling));
    expect(html).toContain(asMarkup(SCOPE_LABELS.all));
  });

  it("renders run rate, days of cover and inbound stock as their own columns", async () => {
    const html = renderToStaticMarkup(
      await CatalogueTable({ tenantId: seeded.tenantId, canViewCosts: true })
    );
    expect(html).toContain("Sells/day");
    expect(html).toContain("Cover");
    expect(html).toContain("On order");

    // An empty shelf with stock en route shows the units and the date, so it
    // does not read as something to order again.
    const inbound = rowBySku(INBOUND_SKU);
    expect(inbound.onHandUnits).toBe(0);
    expect(inbound.onOrderUnits).toBe(INBOUND_UNITS);
    expect(inbound.expectedArrivalAt?.getTime()).toBe(INBOUND_ETA.getTime());
    expect(html).toContain(String(INBOUND_UNITS));
    expect(html).toContain(etaLabel);

    // Cover renders as a number of days for a row that has one.
    const covered = rows.find((r) => r.daysCover != null)!;
    expect(html).toContain(`${covered.daysCover}d`);
  });

  it("surfaces a sync failure on the affected row", async () => {
    expect(rowBySku(SYNC_SKU).syncError).toBe(SYNC_MESSAGE);
    expect(rowBySku(SYNC_SKU).syncErrorAt).not.toBeNull();

    const html = renderToStaticMarkup(
      await CatalogueTable({ tenantId: seeded.tenantId, canViewCosts: true })
    );
    expect(html).toContain(`Sync problem: ${SYNC_MESSAGE}`);
    expect(html).toContain("Sync problem"); // and as a filter chip on the strip
  });

  it("tells sibling variants apart", async () => {
    const siblings = rows.filter((r) => r.shopifyProductId === VARIANT_GROUP);
    expect(siblings).toHaveLength(2);
    expect(siblings.every((r) => r.title === "Velvet Lipstick")).toBe(true);
    expect(siblings.map((r) => r.variantTitle)).toEqual(["Shade 03", "Shade 07"]);
    // A single-variant product carries no label to render.
    expect(rowBySku(SYNC_SKU).variantTitle).toBeNull();

    const html = renderToStaticMarkup(
      await CatalogueTable({ tenantId: seeded.tenantId, canViewCosts: true })
    );
    expect(html).toContain("Shade 03");
    expect(html).toContain("Shade 07");
  });

  it("gives a money-blind member no new money from the lifecycle columns", async () => {
    const memberRows = await getStockCatalogue(seeded.tenantId, { canViewCosts: false });
    for (const row of memberRows) {
      expect(row.costKes).toBeNull();
      expect(row.stockValueKes).toBeNull();
      expect(row.moneyAtRestKes).toBeNull();
      expect(row.marginPct).toBeNull();
    }

    const html = renderToStaticMarkup(
      await CatalogueTable({ tenantId: seeded.tenantId, canViewCosts: false })
    );
    // The new columns are units, rates and dates — nothing that reads as money.
    expect(kesDigits(html)).toHaveLength(0);
    expect(html).toContain(MASK);
    expect(html).toContain("On order");
    expect(html).toContain(String(INBOUND_UNITS));
  });
});
