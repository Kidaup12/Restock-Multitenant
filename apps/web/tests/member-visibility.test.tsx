import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prismaService } from "@wezesha/db";
import { seedDev, type SeedResult } from "../../../packages/db/scripts/seed-dev";
import { hasPermission } from "../lib/auth/permissions";
import { MoneyGate } from "../components/money-gate";
import { getReorderNeeded, getTodayMetrics } from "../lib/data/today";
import { getStockByLocation, getStockCatalogue } from "../lib/data/stock";
import { getBuyList, redactBudgetSplit, splitByBudget } from "../lib/data/plan";

// ReorderTable links to /stock; next/link needs an app-router context that a
// bare renderToStaticMarkup doesn't provide — a plain anchor is equivalent here.
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { MetricsTiles } from "../app/(shell)/today/metrics-tiles";
import { ReorderTable } from "../app/(shell)/today/reorder-table";
import { CatalogueTable } from "../app/(shell)/stock/catalogue-table";
import { LocationView } from "../app/(shell)/stock/location-view";
import {
  CatalogueExportBar,
  catalogueExportColumns,
} from "../app/(shell)/stock/catalogue-export";

/**
 * Money-blindness proof for the live screens, at two depths:
 *
 * 1. Payload: with the MEMBER wiring (canViewCosts=false, exactly what the
 *    pages derive from hasPermission(membership, "view_costs")), the data
 *    layer returns null for every cost field — the numbers never exist in
 *    anything serialized to the client, not just masked at render.
 * 2. Markup: no KES cost figure survives in the rendered HTML — dead-stock
 *    cost, order costs, and stock-value-at-cost all mask, while revenue (a
 *    sales figure) stays visible.
 *
 * Skips without the local database.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

/** Every "KES <digits>" occurrence — a real money figure reaching the markup. */
const kesDigits = (html: string) => html.match(/KES\s[\d][\d,.]*/g) ?? [];
const MASK = "KES •••";

/** KES fields that are sales figures, visible to every role by design. */
const REVENUE_KEYS = new Set([
  "revenueKes",
  "priceKes",
  "revenue30dKes",
  "revenuePrev30dKes",
  "budgetKes",
]);

/** Every numeric non-revenue `*Kes` leaf in a payload, as "path=value". For a
 *  money-blind member this must come back empty — the proof that no cost
 *  number survives serialization. */
function costNumbers(payload: unknown, path = "$"): string[] {
  if (payload === null || typeof payload !== "object") return [];
  if (payload instanceof Date) return [];
  if (Array.isArray(payload)) {
    return payload.flatMap((item, i) => costNumbers(item, `${path}[${i}]`));
  }
  const found: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (/Kes$/.test(key) && !REVENUE_KEYS.has(key) && typeof value === "number") {
      found.push(`${path}.${key}=${value}`);
    }
    found.push(...costNumbers(value, `${path}.${key}`));
  }
  return found;
}

/** Depth-first search of a React element tree (including element-valued props
 *  like CardHeader's `action`) for elements of the given component. */
function findElements(node: unknown, type: unknown, found: unknown[] = []): unknown[] {
  if (Array.isArray(node)) {
    for (const child of node) findElements(child, type, found);
    return found;
  }
  if (!isValidElement(node)) return found;
  if (node.type === type) found.push(node);
  for (const value of Object.values(node.props as Record<string, unknown>)) {
    findElements(value, type, found);
  }
  return found;
}

let seeded: SeedResult;

describe("permission chain", () => {
  it("MEMBER preset lacks view_costs (what the pages key canViewCosts on)", () => {
    expect(hasPermission({ role: "MEMBER", permissions: null }, "view_costs")).toBe(false);
    expect(hasPermission({ role: "OWNER", permissions: null }, "view_costs")).toBe(true);
    expect(hasPermission({ role: "ADMIN", permissions: null }, "view_costs")).toBe(true);
  });

  it("MoneyGate masks for a money-blind membership and passes for an override", () => {
    const blind = renderToStaticMarkup(
      <MoneyGate membership={{ role: "MEMBER", permissions: null }}>KES 1,234</MoneyGate>
    );
    expect(blind).not.toContain("KES 1,234");
    expect(blind).toContain("•••••");

    const granted = renderToStaticMarkup(
      <MoneyGate membership={{ role: "MEMBER", permissions: ["view_costs"] }}>
        KES 1,234
      </MoneyGate>
    );
    expect(granted).toContain("KES 1,234");
  });
});

describe.skipIf(!runnable)("member cost-blindness on live screens (seeded db)", () => {
  beforeAll(async () => {
    seeded = await seedDev();
    // The seed ships no predictions; add a run so ReorderTable renders rows
    // with order costs.
    const products = await prismaService.product.findMany({
      where: { tenantId: seeded.tenantId },
      select: { id: true },
      take: 2,
    });
    await prismaService.prediction.createMany({
      data: products.map((p, index) => ({
        tenantId: seeded.tenantId,
        productId: p.id,
        forecastRunId: "member-vis-run",
        layer1Forecast30d: 30,
        layer1Confidence: 0.8,
        layer2Adjustment: 0,
        finalForecast30d: 30,
        daysUntilStockout: 4 + index,
        recommendedQty: 12,
        safetyStock: 5,
        reorderPoint: 10,
        confidence: 0.8,
        reasoning: "test",
        urgency: "critical",
        signals: "{}",
      })),
    });
  }, 120_000);

  afterAll(async () => {
    await prismaService.prediction.deleteMany({
      where: { tenantId: seeded.tenantId, forecastRunId: "member-vis-run" },
    });
    await prismaService.$disconnect();
  });

  it("Today metrics: revenue visible, dead-stock cost masked", async () => {
    const html = renderToStaticMarkup(
      await MetricsTiles({ tenantId: seeded.tenantId, canViewCosts: false })
    );
    // Exactly one real money figure — the 30d revenue tile.
    expect(kesDigits(html)).toHaveLength(1);
    expect(html).toContain(MASK);

    const owner = renderToStaticMarkup(
      await MetricsTiles({ tenantId: seeded.tenantId, canViewCosts: true })
    );
    expect(kesDigits(owner)).toHaveLength(2); // revenue + dead-stock cost
    expect(owner).not.toContain(MASK);
  });

  it("Today reorder table: order costs masked", async () => {
    const html = renderToStaticMarkup(
      await ReorderTable({ tenantId: seeded.tenantId, canViewCosts: false })
    );
    expect(html).toContain("Reorder needed");
    expect(kesDigits(html)).toHaveLength(0);
    expect(html).toContain(MASK);

    const owner = renderToStaticMarkup(
      await ReorderTable({ tenantId: seeded.tenantId, canViewCosts: true })
    );
    expect(kesDigits(owner).length).toBeGreaterThan(0);
  });

  it("Stock catalogue: stock-value-at-cost masked on every row", async () => {
    const html = renderToStaticMarkup(
      await CatalogueTable({ tenantId: seeded.tenantId, canViewCosts: false })
    );
    expect(kesDigits(html)).toHaveLength(0);
    expect(html.match(new RegExp(MASK, "g"))?.length).toBe(seeded.productCount);

    const owner = renderToStaticMarkup(
      await CatalogueTable({ tenantId: seeded.tenantId, canViewCosts: true })
    );
    expect(kesDigits(owner).length).toBe(seeded.productCount);
  });

  it("Stock by location: per-line and per-location values masked", async () => {
    const html = renderToStaticMarkup(
      await LocationView({ tenantId: seeded.tenantId, canViewCosts: false })
    );
    expect(kesDigits(html)).toHaveLength(0);
    expect(html).toContain(MASK);

    const owner = renderToStaticMarkup(
      await LocationView({ tenantId: seeded.tenantId, canViewCosts: true })
    );
    expect(kesDigits(owner).length).toBeGreaterThan(0);
  });

  // ── Payload depth: the numbers themselves never leave the data layer ──────

  it("today payloads carry no cost numbers for a member (nulls, not masks)", async () => {
    const metrics = await getTodayMetrics(seeded.tenantId, { canViewCosts: false });
    expect(metrics.deadStock.costKes).toBeNull();
    expect(costNumbers(metrics)).toEqual([]);
    expect(metrics.revenue30dKes).toBeGreaterThan(0); // revenue stays

    const reorder = await getReorderNeeded(seeded.tenantId, { canViewCosts: false });
    expect(reorder!.rows.length).toBeGreaterThan(0);
    for (const row of reorder!.rows) expect(row.orderCostKes).toBeNull();
    expect(costNumbers(reorder)).toEqual([]);

    // The owner path keeps real numbers — redaction must not blank everyone.
    const ownerReorder = await getReorderNeeded(seeded.tenantId, { canViewCosts: true });
    expect(costNumbers(ownerReorder).length).toBeGreaterThan(0);
  });

  it("stock payloads carry no cost numbers for a member", async () => {
    const rows = await getStockCatalogue(seeded.tenantId, { canViewCosts: false });
    expect(rows.length).toBe(seeded.productCount);
    for (const row of rows) {
      expect(row.costKes).toBeNull();
      expect(row.stockValueKes).toBeNull();
      expect(typeof row.priceKes).toBe("number"); // selling price is a sales figure
    }
    expect(costNumbers(rows)).toEqual([]);

    const locations = await getStockByLocation(seeded.tenantId, { canViewCosts: false });
    for (const location of locations) {
      expect(location.stockValueKes).toBeNull();
      for (const line of location.lines) expect(line.valueKes).toBeNull();
    }
    expect(costNumbers(locations)).toEqual([]);

    expect(costNumbers(await getStockCatalogue(seeded.tenantId, { canViewCosts: true })).length)
      .toBeGreaterThan(0);
  });

  it("buy-list payload (what PlanView serializes) carries no cost numbers for a member", async () => {
    const buyList = await getBuyList(seeded.tenantId, { canViewCosts: false });
    expect(buyList!.rows.length).toBeGreaterThan(0);
    expect(buyList!.totalCostKes).toBeNull();
    for (const row of buyList!.rows) {
      expect(row.unitCostKes).toBeNull();
      expect(row.lineTotalKes).toBeNull();
      expect(row.atRiskKes).toBeNull();
    }
    expect(costNumbers(buyList)).toEqual([]);

    // Owner list keeps the numbers, and both flags see the same row order.
    const ownerList = await getBuyList(seeded.tenantId, { canViewCosts: true });
    expect(costNumbers(ownerList).length).toBeGreaterThan(0);
    expect(buyList!.rows.map((r) => r.predictionId)).toEqual(
      ownerList!.rows.map((r) => r.predictionId)
    );
  });

  it("budget split redacts every KES aggregate before it leaves the server", async () => {
    const ownerList = await getBuyList(seeded.tenantId, { canViewCosts: true });
    const split = splitByBudget(ownerList!.rows, 100_000);

    const redacted = redactBudgetSplit(split, false);
    expect(redacted.fundedCostKes).toBeNull();
    expect(redacted.deferredCostKes).toBeNull();
    expect(redacted.deferredAtRiskKes).toBeNull();
    expect(redacted.leftoverKes).toBeNull();
    expect(redacted.overBudgetKes).toBeNull();
    expect(redacted.budgetKes).toBe(100_000); // the member's own input survives
    expect(costNumbers(redacted)).toEqual([]);
    // Same items, same order — only the money is gone.
    expect(redacted.funded.map((r) => r.predictionId)).toEqual(
      split.funded.map((r) => r.predictionId)
    );

    // canViewCosts passes the split through untouched.
    expect(redactBudgetSplit(split, true)).toBe(split);
  });

  it("catalogue export bar receives only redacted rows in its serialized props", async () => {
    const tree = await CatalogueTable({ tenantId: seeded.tenantId, canViewCosts: false });
    const bars = findElements(tree, CatalogueExportBar);
    expect(bars).toHaveLength(1);
    // These props are exactly what Next would serialize to the client bundle.
    const props = (bars[0] as { props: unknown }).props;
    expect(costNumbers(props)).toEqual([]);

    const ownerTree = await CatalogueTable({ tenantId: seeded.tenantId, canViewCosts: true });
    const ownerBar = findElements(ownerTree, CatalogueExportBar)[0] as { props: unknown };
    expect(costNumbers(ownerBar.props).length).toBeGreaterThan(0);
  });
});

describe("export column gating", () => {
  it("cost columns exist only for cost viewers", () => {
    const memberHeaders = catalogueExportColumns(false).map((c) => c.header);
    expect(memberHeaders).toEqual(["Product", "SKU", "On hand", "In warehouse", "Days cover", "Status"]);
    const ownerHeaders = catalogueExportColumns(true).map((c) => c.header);
    expect(ownerHeaders).toContain("Unit cost (KES)");
    expect(ownerHeaders).toContain("Stock value (KES)");
  });
});
