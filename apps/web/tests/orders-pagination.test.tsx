import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The Orders screen carries two lists — the order queue and the purchase orders —
 * and they page independently. That is the thing these tests hold: turning to
 * page 2 of the purchase orders must leave the queue exactly where it was, and a
 * queue page must never cut a supplier's card in half, because the reader ticks
 * that card's lines and turns them into one order.
 *
 * The rest is the ordinary paging contract the catalogue already keeps: every
 * page is a distinct slice, the count describes the whole matched list rather
 * than the page, a search narrows it and starts again at page 1, and a page past
 * the end lands on the last real one instead of an empty table.
 *
 * Skips without the local database.
 */

// next/link wants an app-router context a bare static render doesn't provide.
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { prismaService } from "@wezesha/db";
import { seedDev, seedOrdersDemo, type SeedResult } from "../../../packages/db/scripts/seed-dev";
import {
  DEFAULT_ORDERS_QUERY,
  PO_PAGE_SIZE,
  QUEUE_PAGE_SIZE,
  countPurchaseOrders,
  getOrderQueue,
  getOrderQueuePage,
  getPurchaseOrders,
  ordersQueryFields,
  ordersQueryToSearch,
  parseOrdersQuery,
  poListPageBounds,
  type OrdersQuery,
} from "../lib/data/orders";
import { PoList } from "../app/(shell)/orders/po-list";

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

/** Rows this suite owns, so it can clear and rebuild its own fixtures without
 *  touching the seeded demo. */
const PO_PREFIX = "PO-PGE-";
const SUPPLIER = "Pageable Traders";
const QUEUE_SUPPLIER = "Queue Supplier";
const SKU_PREFIX = "PGE-";
/** One PO out of the batch carries a different product, so a search that finds
 *  it can only have matched on the line rather than the supplier or the number. */
const ODD_PRODUCT = "Solitary Sponge";
const EXTRA_POS = 24;

describe("orders screen state <-> URL", () => {
  it("round-trips both lists' pages and the search", () => {
    const q: OrdersQuery = { search: "beauty plus", poPage: 3, queuePage: 2 };
    expect(parseOrdersQuery(qs(ordersQueryToSearch(q)))).toEqual(q);
  });

  it("keeps an untouched screen on a clean /orders URL", () => {
    expect(ordersQueryToSearch(DEFAULT_ORDERS_QUERY)).toBe("");
    expect(parseOrdersQuery({})).toEqual(DEFAULT_ORDERS_QUERY);
  });

  it("gives each list its own page, so paging one leaves the other alone", () => {
    // The failure this guards is quiet: one shared `page` would scroll the queue
    // away the moment someone looked at older purchase orders.
    const q: OrdersQuery = { search: "", poPage: 0, queuePage: 2 };
    const paged = parseOrdersQuery(qs(ordersQueryToSearch({ ...q, poPage: 4 })));
    expect(paged.queuePage).toBe(2);
    expect(paged.poPage).toBe(4);
  });

  it("carries the queue's page through the search form, and starts the list again at page 1", () => {
    const fields = ordersQueryFields({ search: "haria", poPage: 6, queuePage: 3 });
    const names = fields.map((f) => f.name);
    expect(names).toContain("queue");
    // The text is what the input posts; a new search is a new list.
    expect(names).not.toContain("q");
    expect(names).not.toContain("page");

    const posted = qs(
      new URLSearchParams([
        ...fields.map((f) => [f.name, f.value] as [string, string]),
        ["q", "haria"],
      ]).toString()
    );
    expect(parseOrdersQuery(posted)).toEqual({ search: "haria", poPage: 0, queuePage: 3 });
  });

  it("trims, caps and tolerates whatever is typed or hand-edited", () => {
    expect(parseOrdersQuery({ q: "  PO-0001  " }).search).toBe("PO-0001");
    expect(parseOrdersQuery({ q: "x".repeat(500) }).search).toHaveLength(120);
    expect(parseOrdersQuery({ page: "-4", queue: "nonsense" })).toEqual(DEFAULT_ORDERS_QUERY);
  });

  /** `?a=1&b=2` as the shape Next hands a page. */
  function qs(search: string): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of new URLSearchParams(search)) out[k] = v;
    return out;
  }
});

describe.skipIf(!runnable)("paged orders screen (seeded local db)", () => {
  let seeded: SeedResult;
  let total = 0;

  beforeAll(async () => {
    seeded = await seedDev();
    await seedOrdersDemo(seeded.tenantId);
    await clearFixtures(seeded.tenantId);
    total = await buildFixtures(seeded.tenantId);
  }, 180_000);

  afterAll(async () => {
    if (seeded) await clearFixtures(seeded.tenantId);
    await prismaService.$disconnect();
  });

  it("sends one page of purchase orders and counts the whole list", async () => {
    expect(total).toBeGreaterThan(PO_PAGE_SIZE);
    expect(await countPurchaseOrders(seeded.tenantId)).toBe(total);

    const rows = await getPurchaseOrders(seeded.tenantId, { canViewCosts: true, page: 0 });
    expect(rows).toHaveLength(PO_PAGE_SIZE);
    expect(poListPageBounds(total, 0).pageCount).toBe(Math.ceil(total / PO_PAGE_SIZE));
  });

  it("gives every page a distinct slice, and no order twice", async () => {
    const { pageCount } = poListPageBounds(total, 0);
    const seen: string[] = [];
    for (let page = 0; page < pageCount; page++) {
      const rows = await getPurchaseOrders(seeded.tenantId, { canViewCosts: true, page });
      seen.push(...rows.map((r) => r.id));
    }
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(seen.length);

    const first = await getPurchaseOrders(seeded.tenantId, { canViewCosts: true, page: 0 });
    const second = await getPurchaseOrders(seeded.tenantId, { canViewCosts: true, page: 1 });
    expect(second.map((r) => r.id)).not.toEqual(first.map((r) => r.id));
  });

  it("finds an order by its number, its supplier, or something on it", async () => {
    const search = async (q: string) => ({
      matched: await countPurchaseOrders(seeded.tenantId, { search: q }),
      rows: await getPurchaseOrders(seeded.tenantId, {
        canViewCosts: true,
        search: q,
        page: 0,
      }),
    });

    const byNumber = await search(`${PO_PREFIX}07`);
    expect(byNumber.matched).toBe(1);
    expect(byNumber.rows[0]!.poNumber).toBe(`${PO_PREFIX}07`);
    // Narrowing the table does not make the rest of the list look deleted.
    expect(await countPurchaseOrders(seeded.tenantId)).toBe(total);

    const bySupplier = await search("pageable");
    expect(bySupplier.matched).toBe(EXTRA_POS);
    expect(bySupplier.rows.every((r) => r.supplierName === SUPPLIER)).toBe(true);

    const byProduct = await search("sponge");
    expect(byProduct.matched).toBe(1);

    const nothing = await search("zzzz-no-such-order");
    expect(nothing.matched).toBe(0);
    expect(nothing.rows).toHaveLength(0);
    // Still a real page, so the pager cannot land the reader out of bounds.
    const bounds = poListPageBounds(nothing.matched, 0);
    expect(bounds.current).toBe(0);
    expect(bounds.pageCount).toBe(1);
  });

  it("clamps a page past the end instead of showing an empty table", async () => {
    const { pageCount, current } = poListPageBounds(total, 999);
    expect(current).toBe(pageCount - 1);
    const rows = await getPurchaseOrders(seeded.tenantId, { canViewCosts: true, page: current });
    expect(rows.length).toBeGreaterThan(0);
  });

  it("still redacts costs for a money-blind member on a page", async () => {
    const rows = await getPurchaseOrders(seeded.tenantId, { canViewCosts: false, page: 0 });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.subtotalKes).toBeNull();
  });

  it("shows the reader how much of the list is on screen", async () => {
    const markup = await render(
      await PoList({ tenantId: seeded.tenantId, query: DEFAULT_ORDERS_QUERY })
    );
    expect(markup).toContain(`Showing 1–${PO_PAGE_SIZE} of ${total}`);
    // And a way to the rest of it.
    expect(markup).toContain("Next →");
    expect(markup).toContain("page=2");
  });

  it("pages the queue whole supplier cards, never half of one", async () => {
    const all = await getOrderQueue(seeded.tenantId, { canViewCosts: true });
    expect(all.length).toBeGreaterThan(QUEUE_PAGE_SIZE);

    const first = await getOrderQueuePage(seeded.tenantId, { canViewCosts: true, page: 0 });
    expect(first.total).toBe(all.length);
    expect(first.groups).toHaveLength(QUEUE_PAGE_SIZE);

    const seen: typeof all = [];
    for (let page = 0; page < first.pageCount; page++) {
      const slice = await getOrderQueuePage(seeded.tenantId, { canViewCosts: true, page });
      seen.push(...slice.groups);
    }
    // Every card arrives once and intact: same suppliers, same lines, same order
    // as the unpaged queue. A card split across two pages would break both the
    // running total and the Create PO button on it.
    expect(seen).toEqual(all);

    const second = await getOrderQueuePage(seeded.tenantId, { canViewCosts: true, page: 1 });
    expect(second.groups.map((g) => g.supplierId)).not.toEqual(
      first.groups.map((g) => g.supplierId)
    );
  });
});

async function render(element: ReactNode): Promise<string> {
  return renderToStaticMarkup(element as never).replace(/<!-- -->/g, "");
}

/** Purchase orders and a queue longer than one page of each. */
async function buildFixtures(tenantId: string): Promise<number> {
  const supplier = await prismaService.supplier.create({
    data: { tenantId, name: SUPPLIER, leadTimeAvgDays: 14 },
  });
  const [common, odd] = await Promise.all([
    prismaService.product.create({
      data: { tenantId, sku: `${SKU_PREFIX}COMMON`, title: "Pageable Pomade", costKes: 100 },
    }),
    prismaService.product.create({
      data: { tenantId, sku: `${SKU_PREFIX}ODD`, title: ODD_PRODUCT, costKes: 250 },
    }),
  ]);

  // Distinct creation times: two orders created in the same millisecond have no
  // stable order between them, which is how a row appears on two pages at once.
  const base = Date.now();
  for (let i = 1; i <= EXTRA_POS; i++) {
    const product = i === 1 ? odd : common;
    await prismaService.purchaseOrder.create({
      data: {
        tenantId,
        supplierId: supplier.id,
        poNumber: `${PO_PREFIX}${String(i).padStart(2, "0")}`,
        status: "sent",
        subtotalKes: product.costKes * 4,
        createdAt: new Date(base - i * 3_600_000),
        sentAt: new Date(base - i * 3_600_000),
        lines: {
          create: [
            {
              tenantId,
              productId: product.id,
              sku: product.sku,
              title: product.title,
              quantity: 4,
              unitCostKes: product.costKes,
              lineTotalKes: product.costKes * 4,
            },
          ],
        },
      },
    });
  }

  // More queued suppliers than one queue page holds.
  for (let i = 1; i <= QUEUE_PAGE_SIZE + 2; i++) {
    const s = await prismaService.supplier.create({
      data: { tenantId, name: `${QUEUE_SUPPLIER} ${i}`, moq: 1 },
    });
    const p = await prismaService.product.create({
      data: {
        tenantId,
        sku: `${SKU_PREFIX}Q${i}`,
        title: `Queued Item ${i}`,
        costKes: 50 + i,
        currentStock: 2,
        supplierId: s.id,
      },
    });
    await prismaService.order.create({
      data: { tenantId, status: "pending", productId: p.id, orderedQty: 6 },
    });
  }

  return prismaService.purchaseOrder.count({ where: { tenantId, deletedAt: null } });
}

async function clearFixtures(tenantId: string): Promise<void> {
  await prismaService.purchaseOrder.deleteMany({
    where: { tenantId, poNumber: { startsWith: PO_PREFIX } },
  });
  const products = await prismaService.product.findMany({
    where: { tenantId, sku: { startsWith: SKU_PREFIX } },
    select: { id: true },
  });
  const ids = products.map((p) => p.id);
  if (ids.length) {
    await prismaService.order.deleteMany({ where: { tenantId, productId: { in: ids } } });
    await prismaService.product.deleteMany({ where: { id: { in: ids } } });
  }
  await prismaService.supplier.deleteMany({
    where: {
      tenantId,
      OR: [{ name: SUPPLIER }, { name: { startsWith: QUEUE_SUPPLIER } }],
    },
  });
}
