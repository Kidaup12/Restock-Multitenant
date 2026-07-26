import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prismaService } from "@wezesha/db";
import { seedDev, type SeedResult } from "../../../packages/db/scripts/seed-dev";
import { hasPermission } from "../lib/auth/permissions";
import { MoneyGate } from "../components/money-gate";
import { formatCompact } from "../components/ui/cost-value";
import { getReorderNeeded, getTodayMetrics } from "../lib/data/today";
import { getStockByLocation, getStockCatalogue } from "../lib/data/stock";
import { getBuyList, redactBudgetSplit, splitByBudget, type BuyListRow } from "../lib/data/plan";
import { getInsightsOverview } from "../lib/data/insights";

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
import { CatalogueView } from "../app/(shell)/stock/catalogue-view";
import { LocationView } from "../app/(shell)/stock/location-view";
import { catalogueExportColumns } from "../app/(shell)/stock/catalogue-export";
import { ShelfHealth } from "../app/(shell)/insights/shelf-health";

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
  // price x run rate — what an empty shelf costs in sales, not a cost figure.
  "missedSalesKes",
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

  it("Stock catalogue: cost + cash-tied-up masked on every row, revenue stays", async () => {
    const html = renderToStaticMarkup(
      await CatalogueTable({ tenantId: seeded.tenantId, canViewCosts: false })
    );
    // No cost KES leaks: unit cost and per-row cash-tied-up both mask, revenue is
    // rendered as a bare number (its KES unit is in the header), so nothing
    // matches "KES <digits>". The money band is not rendered for a money-blind
    // member. Two masked cost columns per row → two masks each.
    expect(kesDigits(html)).toHaveLength(0);
    expect(html.match(new RegExp(MASK, "g"))?.length).toBe(seeded.productCount * 2);

    const owner = renderToStaticMarkup(
      await CatalogueTable({ tenantId: seeded.tenantId, canViewCosts: true })
    );
    // The owner sees real KES cost figures (unit cost + cash tied up per row, plus
    // the money band) and no mask.
    expect(kesDigits(owner).length).toBeGreaterThanOrEqual(seeded.productCount);
    expect(owner).not.toContain(MASK);
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
    // Actual trailing revenue is a sales figure — it STAYS visible for a member
    // (never nulled), identical to what the owner sees.
    for (const row of buyList!.rows) expect(typeof row.revenue30dKes).toBe("number");
    expect(buyList!.rows.map((r) => r.revenue30dKes)).toEqual(
      ownerList!.rows.map((r) => r.revenue30dKes)
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

  it("catalogue view receives only redacted rows in its serialized props", async () => {
    // The server table hands the (redacted) rows to the client CatalogueView —
    // that prop boundary is exactly what Next serializes into the client bundle,
    // so a money-blind member's rows must carry no cost numbers.
    const tree = await CatalogueTable({ tenantId: seeded.tenantId, canViewCosts: false });
    const views = findElements(tree, CatalogueView);
    expect(views).toHaveLength(1);
    const props = (views[0] as { props: unknown }).props;
    expect(costNumbers(props)).toEqual([]);

    const ownerTree = await CatalogueTable({ tenantId: seeded.tenantId, canViewCosts: true });
    const ownerView = findElements(ownerTree, CatalogueView)[0] as { props: unknown };
    expect(costNumbers(ownerView.props).length).toBeGreaterThan(0);
  });

  it("insights masks every cost figure for a member while keeping the sales ones", async () => {
    // Insights shows both kinds of money: cash tied up in stock (a cost, must
    // mask) and the sales an empty shelf is losing (price x run rate, which a
    // member may see, like revenue). So "no KES on screen" is the wrong test —
    // the test is that no OWNER-ONLY figure appears in the member's markup.
    const [ownerData, member, owner] = await Promise.all([
      getInsightsOverview(seeded.tenantId, { canViewCosts: true }),
      ShelfHealth({ tenantId: seeded.tenantId, canViewCosts: false }).then(renderToStaticMarkup),
      ShelfHealth({ tenantId: seeded.tenantId, canViewCosts: true }).then(renderToStaticMarkup),
    ]);

    const costFigures = [ownerData.cashTotalKes, ...ownerData.cashRows.map((r) => r.cashKes)]
      .filter((v): v is number => v != null && v > 0)
      .map((v) => formatCompact(v));
    expect(costFigures.length).toBeGreaterThan(0); // the test would be vacuous otherwise

    for (const figure of costFigures) {
      expect(owner).toContain(figure); // the owner really does see them...
      expect(member).not.toContain(`KES ${figure}`); // ...and the member does not
    }
    expect(member).toContain(MASK);
    expect(owner).not.toContain(MASK);
  });

  it("keeps every cost out of the insights payload, not just out of the markup", async () => {
    const member = await getInsightsOverview(seeded.tenantId, { canViewCosts: false });
    expect(costNumbers(member)).toEqual([]);
    const owner = await getInsightsOverview(seeded.tenantId, { canViewCosts: true });
    expect(costNumbers(owner).length).toBeGreaterThan(0);
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

/** No database needed — drives the redactor directly, so it runs everywhere. */
describe("plan buy-list redaction (pure)", () => {
  const mkRow = (revenue30dKes: number): BuyListRow => ({
    predictionId: "p1",
    productId: "prod1",
    sku: "SKU1",
    title: "Item",
    vendor: null,
    supplierName: null,
    onHandUnits: 5,
    onOrderUnits: 0,
    daysUntilStockout: 6,
    daysLeftToOrder: 2,
    leadDays: 4,
    orderByDate: new Date(),
    urgency: "high",
    tier: "this_week",
    recommendedQty: 10,
    overriddenQty: null,
    runRatePerDay: 1.5,
    moq: 1,
    abc: "A",
    category: null,
    unitCostKes: 100,
    lineTotalKes: 1000,
    priceKes: 200,
    reasoning: "x",
    explain: null,
    qtySummary: "s",
    plannable: "ok",
    atRiskKes: 0,
    revenue30dKes,
  });

  it("nulls costs for a member but keeps the member-visible trailing revenue", () => {
    const split = splitByBudget([mkRow(5000)], 100_000);
    const member = redactBudgetSplit(split, false);
    // Cost/margin figures go dark for a member...
    expect(member.funded[0]!.lineTotalKes).toBeNull();
    expect(member.funded[0]!.atRiskKes).toBeNull();
    // ...but actual trailing revenue is a sales figure — it stays.
    expect(member.funded[0]!.revenue30dKes).toBe(5000);
    // Non-money planning fields survive too.
    expect(member.funded[0]!.runRatePerDay).toBe(1.5);
    expect(member.funded[0]!.abc).toBe("A");
    // No non-revenue *Kes cost number leaks (revenue30dKes is allowlisted).
    expect(costNumbers(member.funded)).toEqual([]);
    expect(redactBudgetSplit(split, true).funded[0]!.revenue30dKes).toBe(5000);
  });

  it("an owner-overridden row keeps its quantity but still hides the line total from a member", () => {
    // The override changes the qty (and therefore the line total). The qty is
    // operational and stays; the money it implies is redacted like any other.
    const row: BuyListRow = { ...mkRow(0), overriddenQty: 8, recommendedQty: 8, lineTotalKes: 800 };
    const member = redactBudgetSplit(splitByBudget([row], 100_000), false);
    expect(member.funded[0]!.overriddenQty).toBe(8);
    expect(member.funded[0]!.recommendedQty).toBe(8);
    expect(member.funded[0]!.lineTotalKes).toBeNull();
    expect(costNumbers(member.funded)).toEqual([]);
  });
});
