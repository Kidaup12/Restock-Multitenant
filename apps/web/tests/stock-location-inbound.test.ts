import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { prismaService } from "@wezesha/db";
import { LocationView } from "../app/(shell)/stock/location-view";

/**
 * Inbound stock, and a stable set of columns, on the per-location table.
 *
 * Two things a shop looking at a branch needs. First, what is already on its
 * way: the table listed on-hand and value only, so an empty shelf with a sent
 * purchase order read as something to order again. Second, the same columns
 * every time — cover only appeared on selling locations, so the table changed
 * shape between the shop floor and the back store.
 *
 * The column is "En route", not "On order": the figure counts stock already
 * moving — units at an en-route location plus Shopify's incoming — held against
 * what suppliers still owe us on a sent purchase order. "On order" would read as
 * "orders we placed", which is only half of it.
 *
 * It is also a SHOP-WIDE figure and the column says so, exactly as cover does:
 * that roll-up spans the whole shop, and a purchase order names no destination
 * branch. Printing it against one branch unlabelled would claim a delivery
 * address the data does not know.
 *
 * Fixtures build their own tenant so the shared seed is untouched.
 * Skips when no local database is configured.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const SLUG = "stock-location-inbound";
const SHOP = "Riverside Counter";
const STORE = "Riverside Back Store";
const INBOUND_SKU = "LI-INBOUND";
const SETTLED_SKU = "LI-SETTLED";

/** Shopify's count (24) sits above our outstanding PO (10): the units must read
 *  24 — the MAX of the two views, never their sum — while the date comes from
 *  the purchase order, the only place that has one. */
const SHOPIFY_INBOUND = 24;
const PO_UNITS = 10;
const INBOUND_ETA = new Date(Date.UTC(2031, 4, 18));
const etaLabel = INBOUND_ETA.toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** Everything between a location's name and the end of its table. */
const cardFor = (html: string, name: string) => {
  const start = html.indexOf(name);
  expect(start, `no card for ${name}`).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</table>", start));
};

/** The one row a SKU renders in. */
const rowFor = (card: string, sku: string) => {
  const at = card.indexOf(sku);
  expect(at, `no row for ${sku}`).toBeGreaterThan(-1);
  return card.slice(card.lastIndexOf("<tr", at), card.indexOf("</tr>", at));
};

const dashes = (markup: string) => (markup.match(/—/g) ?? []).length;

/** Every "KES <digits>" occurrence — a real money figure reaching the markup. */
const kesDigits = (html: string) => html.match(/KES\s[\d][\d,.]*/g) ?? [];

describe.skipIf(!runnable)("inbound stock on the per-location table (local db)", () => {
  let tenantId: string;
  let ownerHtml: string;
  let memberHtml: string;

  beforeAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    const tenant = await prismaService.tenant.create({
      data: { name: "Riverside", slug: SLUG, currency: "KES" },
    });
    tenantId = tenant.id;

    const base = { tenantId, vendor: "House", priceKes: 1000, costKes: 400 };
    const inbound = await prismaService.product.create({
      data: { ...base, sku: INBOUND_SKU, title: "Sunrise Toner", currentStock: 6, onOrder: SHOPIFY_INBOUND },
    });
    const settled = await prismaService.product.create({
      data: { ...base, sku: SETTLED_SKU, title: "Evening Balm", currentStock: 5 },
    });

    const shop = await prismaService.location.create({
      data: { tenantId, name: SHOP, locationType: "branch", roleStatus: "confirmed", isPrimary: true },
    });
    const store = await prismaService.location.create({
      data: { tenantId, name: STORE, locationType: "warehouse", roleStatus: "confirmed" },
    });
    await prismaService.inventoryLevel.createMany({
      data: [
        { tenantId, locationId: shop.id, productId: inbound.id, onHand: 6, available: 6 },
        { tenantId, locationId: shop.id, productId: settled.id, onHand: 5, available: 5 },
        { tenantId, locationId: store.id, productId: inbound.id, onHand: 3, available: 3 },
        { tenantId, locationId: store.id, productId: settled.id, onHand: 2, available: 2 },
      ],
    });

    // Both products sell, so cover is a real number at the shop floor — without
    // a run rate every cover cell reads "—" and the em-dash counts below could
    // not tell the cover column from the inbound one.
    const day = 86_400_000;
    await prismaService.salesHistory.createMany({
      data: Array.from({ length: 14 }, (_, i) => i + 1).flatMap((back) =>
        [inbound.id, settled.id].map((productId) => ({
          tenantId,
          productId,
          date: new Date(Date.now() - back * day),
          quantity: 1,
          revenueKes: 1000,
          channel: "shopify",
        }))
      ),
    });

    await prismaService.purchaseOrder.create({
      data: {
        tenantId,
        poNumber: "PO-LI-1",
        status: "sent",
        sentAt: new Date(),
        expectedAt: INBOUND_ETA,
        lines: {
          create: {
            tenantId,
            productId: inbound.id,
            sku: INBOUND_SKU,
            title: "Sunrise Toner",
            quantity: PO_UNITS,
            receivedQty: 0,
            unitCostKes: 400,
            lineTotalKes: PO_UNITS * 400,
          },
        },
      },
    });

    ownerHtml = renderToStaticMarkup(await LocationView({ tenantId, canViewCosts: true }));
    memberHtml = renderToStaticMarkup(await LocationView({ tenantId, canViewCosts: false }));
  }, 120_000);

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    await prismaService.$disconnect();
  });

  it("shows what is on its way, with the date it is due", () => {
    const card = cardFor(ownerHtml, SHOP);
    expect(card).toContain("En route (shop)");

    const row = rowFor(card, INBOUND_SKU);
    // MAX of the two inbound views, not their sum: 24, never 34.
    expect(row).toContain(`>${SHOPIFY_INBOUND}<`);
    expect(row).not.toContain(`>${SHOPIFY_INBOUND + PO_UNITS}<`);
    expect(row).toContain(etaLabel);
  });

  it("keeps the column when there is nothing coming, rather than dropping it", () => {
    const row = rowFor(cardFor(ownerHtml, SHOP), SETTLED_SKU);
    // Cover reads as days here, so the single em-dash is the inbound cell.
    expect(row).toMatch(/>\d+d<\/span>/);
    expect(dashes(row)).toBe(1);
  });

  it("shows the same columns at a location that does not sell", () => {
    const card = cardFor(ownerHtml, STORE);
    expect(card).toContain("Cover (shop)");
    expect(card).toContain("En route (shop)");

    // A warehouse has no cover of its own, so that cell is the em-dash — the
    // column is still there to read.
    const row = rowFor(card, INBOUND_SKU);
    expect(row).toContain(`>${SHOPIFY_INBOUND}<`);
    expect(dashes(row)).toBe(1);
  });

  it("gives a money-blind member the units and no money", () => {
    const row = rowFor(cardFor(memberHtml, SHOP), INBOUND_SKU);
    expect(row).toContain(`>${SHOPIFY_INBOUND}<`);
    expect(row).toContain(etaLabel);
    expect(kesDigits(memberHtml)).toHaveLength(0);
  });
});
