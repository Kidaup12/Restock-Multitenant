import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";
import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BUYABLE_PRODUCT_WHERE, prismaService } from "@wezesha/db";
import { seedDev, type SeedResult } from "../../../packages/db/scripts/seed-dev";
import { hasPermission } from "../lib/auth/permissions";
import { MoneyGate } from "../components/money-gate";
import { formatCompact } from "../lib/money";
import { getDashboardTable, getReorderNeeded, getTodayMetrics } from "../lib/data/today";
import { getStockByLocation, getStockCatalogue } from "../lib/data/stock";
import { getProductDetail } from "../lib/data/product-detail";
import {
  getBuyList,
  redactBudgetSplit,
  redactBuyList,
  splitByBudget,
  type BuyList,
  type BuyListRow,
} from "../lib/data/plan";
import { getInsightsOverview } from "../lib/data/insights";
import { getCostCoverage, getCostMovedAlerts } from "../lib/data/costs";
import { getUnreadCount, listNotifications } from "../lib/notifications/data";
import {
  COST_COLUMNS,
  COST_SURFACES,
  COST_SURFACE_DIR,
  surfaceKey,
} from "../lib/cost/surfaces";
import { getDistributionProposal } from "../lib/data/transfers";

// The dashboard links out to /plan and /products; next/link needs an app-router context that a
// bare renderToStaticMarkup doesn't provide — a plain anchor is equivalent here.
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

// The transfers proposal renders its save bar, a client component that reaches
// for the router on mount; a static render has no app-router context.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

import { ProductBoard } from "../app/(shell)/today/product-board";
import { CatalogueTable } from "../app/(shell)/products/catalogue-table";
import { CatalogueView } from "../app/(shell)/products/catalogue-view";
import { DEFAULT_QUERY } from "../lib/catalogue";
import { LocationView } from "../app/(shell)/inventory/location-view";
import { catalogueExportColumns } from "../app/(shell)/products/catalogue-export";
import { ShelfHealth } from "../app/(shell)/insights/shelf-health";
import { CostMovedList } from "../app/(shell)/costs/cost-moved-list";
import { ProposalView } from "../app/(shell)/transfers/proposal-view";
import { transferExportColumns } from "../app/(shell)/transfers/transfers-export";

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

/** Keys that answer a question about cost without carrying a figure: does this
 *  product have one, where did it come from, is it above the selling price.
 *  A truthy value on any of them is as much a disclosure as the number. */
const COST_DERIVED_KEYS = new Set([
  "costSource",
  "missingCost",
  "suspectCost",
  "heldOffBuyList",
  "costMovedPct",
  "costMovedAt",
]);

/** The companion to costNumbers, and the one that would have caught the leak it
 *  missed: cost facts expressed as a boolean or a label. `costNumbers` only
 *  matches numeric keys ending in "Kes", so `suspectCost: true` — true exactly
 *  when cost >= price — sailed through it, and through the catalogue's filter
 *  chips with it. Must also come back empty for a money-blind caller. */
function costSignals(payload: unknown, path = "$"): string[] {
  if (payload === null || typeof payload !== "object") return [];
  if (payload instanceof Date) return [];
  if (Array.isArray(payload)) {
    return payload.flatMap((item, i) => costSignals(item, `${path}[${i}]`));
  }
  const found: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (COST_DERIVED_KEYS.has(key) && value !== null && value !== false && value !== undefined) {
      found.push(`${path}.${key}=${String(value)}`);
    }
    // The catalogue ships health flags as a string array, so the cost-derived
    // one has to be caught by value rather than by key.
    if (key === "health" && Array.isArray(value) && value.includes("missing_cost")) {
      found.push(`${path}.health[missing_cost]`);
    }
    found.push(...costSignals(value, `${path}.${key}`));
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

/**
 * The surfaces this suite covers are DERIVED, not restated. `lib/data` is
 * scanned for exported functions that touch a cost column and the result is
 * compared with `lib/cost/surfaces.ts`; a new cost-bearing getter fails
 * here on the day it lands, whether or not its author knew this file existed.
 *
 * Scope, stated plainly: this checks the data layer, where redaction happens.
 * A component that renders a cost it was handed is not scanned, and neither is
 * a leak by derivation — a rank, a partition or a percentage computed FROM
 * costs carries no cost column and no scan will see it. Those are the tests
 * further down, written by hand, and they stay that way.
 */
describe("cost-surface manifest", () => {
  /** Exported functions in `dir` whose body names a cost column. Deliberately
   *  broader than the lint rule, which only looks at Prisma `select` literals:
   *  a false positive here costs one manifest line, not a disabled build rule. */
  function scanCostSurfaces(dir: string): string[] {
    const found: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const path = `${dir}/${file}`;
      const source = ts.createSourceFile(
        path,
        readFileSync(path, "utf8"),
        ts.ScriptTarget.Latest,
        true
      );
      for (const statement of source.statements) {
        const exported = ts
          .getModifiers(statement as ts.HasModifiers)
          ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        if (!exported) continue;

        let fn: ts.SignatureDeclaration | undefined;
        let name: string | undefined;
        if (ts.isFunctionDeclaration(statement)) {
          fn = statement;
          name = statement.name?.text;
        } else if (ts.isVariableStatement(statement)) {
          const declaration = statement.declarationList.declarations[0];
          const init = declaration?.initializer;
          if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
            fn = init;
            name = declaration!.name.getText(source);
          }
        }
        const body = (fn as ts.FunctionLikeDeclaration | undefined)?.body;
        if (!fn || !body || !name) continue;

        const text = body.getText(source);
        if (COST_COLUMNS.some((column) => new RegExp(`\\b${column}\\b`).test(text))) {
          found.push(surfaceKey({ module: path.replace(/\.ts$/, ""), getter: name }));
        }
      }
    }
    return found.sort();
  }

  it("declares every cost-bearing getter in lib/data — no more, no less", () => {
    const scanned = scanCostSurfaces(COST_SURFACE_DIR);
    expect(scanned.length).toBeGreaterThan(0); // a scan that found nothing proves nothing
    expect(scanned).toEqual(COST_SURFACES.map(surfaceKey).sort());
  });

  it("names, for each surface, a suite that exercises it money-blind", () => {
    for (const surface of COST_SURFACES) {
      const proof = readFileSync(surface.provenBy, "utf8");
      expect(proof, `${surface.provenBy} never calls ${surface.getter}`).toContain(surface.getter);
      expect(proof, `${surface.provenBy} never runs anything money-blind`).toContain(
        "canViewCosts: false"
      );
    }
  });

  it("keeps the lint rule's cost columns and the manifest's identical", async () => {
    // The rule is a plain-JS ESLint plugin and cannot import the manifest, so
    // the list exists twice. A column taught to one and not the other would
    // leave a real gap in whichever half was forgotten.
    const { COST_COLUMNS: ruleColumns } = await import("../eslint-rules/cost-visibility.mjs");
    expect([...ruleColumns].sort()).toEqual([...COST_COLUMNS].sort());
  });
});

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
    // The seed ships no predictions; add a run so the board renders rows
    // with order costs.
    const products = await prismaService.product.findMany({
      where: { tenantId: seeded.tenantId },
      select: { id: true },
      take: 3,
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
        // The third is sized to nothing and carries the trust columns, so the
        // not-on-the-list surface and the confidence word both have something
        // to be asserted against — with two positive rows and no words, the
        // money-blind checks below would pass on an empty set.
        recommendedQty: index === 2 ? 0 : 12,
        confidenceWord: index === 2 ? "guessing" : "sure",
        coldStart: index === 2 ? "too_new" : null,
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

  it("Today board: not one cost figure reaches a money-blind member", async () => {
    // The dashboard's only cost figure is the dead-stock cash on its card. The
    // card renders a SKU count instead for a member, so the honest assertion is
    // that no KES reaches them at all — not that something masks. (The trend
    // chart carries the revenue and is passed in separately; it is not a cost.)
    const member = renderToStaticMarkup(
      await ProductBoard({ tenantId: seeded.tenantId, canViewCosts: false, currency: "KES", trend: null })
    );
    expect(kesDigits(member)).toHaveLength(0);
    // And not even a masked one. The data layer nulls the figure, so a card that
    // wrongly rendered it would show "KES •••" rather than digits — which the
    // digit check alone cannot see. Without this the assertion passes whether or
    // not the leak exists, which is worse than having no assertion.
    expect(member).not.toContain(MASK);

    const owner = renderToStaticMarkup(
      await ProductBoard({ tenantId: seeded.tenantId, canViewCosts: true, currency: "KES", trend: null })
    );
    // The owner sees what the dead stock is costing — the figure this shop
    // judges the product by.
    expect(kesDigits(owner).length).toBeGreaterThan(0);
  });

  it("Today board: no per-line order money, owner included", async () => {
    // The dashboard names what needs attention and, for an owner, what the
    // urgent slice costs in total — enough to know whether it can be paid for
    // this week. What stays in the planner is the per-line arithmetic: the
    // quantity for each product and the cost of each line, which need the
    // budget and horizon that size an order. A member sees no cost figure at
    // all; that is the assertion above, not this one.
    for (const canViewCosts of [false, true]) {
      const html = renderToStaticMarkup(
        await ProductBoard({ tenantId: seeded.tenantId, canViewCosts, currency: "KES", trend: null })
      );
      expect(html).not.toContain("Order cost");
      expect(html).not.toContain("Reorder qty");
      expect(html).toContain("/plan");
    }
  });

  it("Stock catalogue: cost + cash-tied-up masked on every row, revenue stays", async () => {
    const html = renderToStaticMarkup(
      await CatalogueTable({ tenantId: seeded.tenantId, canViewCosts: false, query: DEFAULT_QUERY })
    );
    // No cost KES leaks: unit cost and per-row cash-tied-up both mask, revenue is
    // rendered as a bare number (its KES unit is in the header), so nothing
    // matches "KES <digits>". The money band is not rendered for a money-blind
    // member. Two masked cost columns per row → two masks each.
    expect(kesDigits(html)).toHaveLength(0);
    expect(html.match(new RegExp(MASK, "g"))?.length).toBe(seeded.productCount * 2);

    const owner = renderToStaticMarkup(
      await CatalogueTable({ tenantId: seeded.tenantId, canViewCosts: true, query: DEFAULT_QUERY })
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

  it("the dashboard table carries no cost numbers for a member", async () => {
    // It gained a second cost figure — what the urgent slice costs to restock —
    // alongside the dead-stock cash it already carried. Both are summed from
    // rows the member is allowed to see, which is exactly how a redacted screen
    // leaks: the figure is derived, not fetched.
    const member = await getDashboardTable(seeded.tenantId, { canViewCosts: false });
    expect(member.deadCostKes).toBeNull();
    expect(member.criticalCostKes, "a member was told what the urgent slice costs").toBeNull();
    // Not a blanket sweep here: the dead-stock export deliberately carries
    // value at RETAIL, which is price x on-hand — a sales figure every role can
    // see. Asserting "no KES anywhere" would forbid it and be wrong.
    for (const row of member.deadStockExport) expect(row.valueAtCostKes).toBeNull();

    // And the owner still gets real numbers — redaction must not blank everyone.
    const owner = await getDashboardTable(seeded.tenantId, { canViewCosts: true });
    expect(owner.criticalCostKes).not.toBeNull();
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

  it("stock payloads carry no cost SIGNALS for a member either", async () => {
    // The half costNumbers is blind to. `suspectCost` is true exactly when cost
    // >= price and `costSource` says whether a cost exists at all — neither is a
    // number, both answer a question about cost, and the catalogue turned the
    // first into a filter chip that selected precisely those products.
    //
    // THE SEED HAS NEITHER SHAPE: every seeded product carries a healthy cost
    // below its price, so asserting `suspectCost === false` against it passes
    // whatever the code does. The fixture below is what gives this test teeth —
    // without it the only assertion doing work is `costSource`.
    const [dear, costless] = await prismaService.product.findMany({
      where: { tenantId: seeded.tenantId, ...BUYABLE_PRODUCT_WHERE },
      orderBy: { sku: "asc" },
      take: 2,
    });
    await prismaService.product.update({
      where: { id: dear!.id },
      data: { costKes: dear!.priceKes + 50, costSource: "manual" },
    });
    await prismaService.product.update({
      where: { id: costless!.id },
      data: { costKes: 0, costSource: null },
    });

    try {
      const ownerRows = await getStockCatalogue(seeded.tenantId, { canViewCosts: true });
      // Prove the fixture landed before trusting anything it is meant to catch.
      expect(ownerRows.find((r) => r.productId === dear!.id)!.suspectCost).toBe(true);
      expect(ownerRows.find((r) => r.productId === costless!.id)!.missingCost).toBe(true);
      expect(ownerRows.find((r) => r.productId === costless!.id)!.facet.health).toContain(
        "missing_cost"
      );

      const rows = await getStockCatalogue(seeded.tenantId, { canViewCosts: false });
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.costSource, row.sku).toBeNull();
        expect(row.suspectCost, row.sku).toBe(false);
        expect(row.missingCost, row.sku).toBe(false);
        expect(row.heldOffBuyList, row.sku).toBe(false);
        expect(row.facet.health, row.sku).not.toContain("missing_cost");
      }
      expect(costSignals(rows)).toEqual([]);
      expect(costSignals(ownerRows).length).toBeGreaterThan(0);
    } finally {
      await prismaService.product.update({
        where: { id: dear!.id },
        data: { costKes: dear!.costKes, costSource: dear!.costSource },
      });
      await prismaService.product.update({
        where: { id: costless!.id },
        data: { costKes: costless!.costKes, costSource: costless!.costSource },
      });
    }
  });

  it("product detail hides where the cost came from, not just the figure", async () => {
    const product = await prismaService.product.findFirstOrThrow({
      where: { tenantId: seeded.tenantId, ...BUYABLE_PRODUCT_WHERE },
    });
    const [member, owner] = await Promise.all([
      getProductDetail(seeded.tenantId, product.id, { canViewCosts: false }),
      getProductDetail(seeded.tenantId, product.id, { canViewCosts: true }),
    ]);
    expect(member!.costSource).toBeNull();
    expect(owner!.costSource).not.toBeNull(); // vacuity guard
    expect(costSignals(member)).toEqual([]);
  });

  it("the catalogue's cost-moved flag is hidden from a member, not just its figure", async () => {
    // The catalogue builds a "Cost moved" facet chip and a row dot from these
    // fields. Filtering by that chip names the products whose buying price
    // jumped, so the flag discloses more than the percentage does.
    const product = await prismaService.product.findFirst({
      where: { tenantId: seeded.tenantId, ...BUYABLE_PRODUCT_WHERE },
      select: { id: true },
    });
    await prismaService.product.update({
      where: { id: product!.id },
      data: { costMovedPct: 37.5, costMovedAt: new Date() },
    });

    const member = await getStockCatalogue(seeded.tenantId, { canViewCosts: false });
    for (const row of member) {
      expect(row.costMovedPct).toBeNull();
      expect(row.costMovedAt).toBeNull();
    }

    // The owner still sees it — this is a redaction, not a removal.
    const owner = await getStockCatalogue(seeded.tenantId, { canViewCosts: true });
    expect(owner.some((r) => r.costMovedPct === 37.5)).toBe(true);

    await prismaService.product.update({
      where: { id: product!.id },
      data: { costMovedPct: null, costMovedAt: null },
    });
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

    // Owner list keeps the numbers, and both flags see the same rows — but the
    // member's ORDER is built without costs (see the ordering row below).
    const ownerList = await getBuyList(seeded.tenantId, { canViewCosts: true });
    expect(costNumbers(ownerList).length).toBeGreaterThan(0);
    expect(new Set(buyList!.rows.map((r) => r.predictionId))).toEqual(
      new Set(ownerList!.rows.map((r) => r.predictionId))
    );
    // Actual trailing revenue is a sales figure — it STAYS visible for a member
    // (never nulled), identical to what the owner sees. Matched by row, since
    // the two lists are ordered differently.
    const ownerRevenue = new Map(ownerList!.rows.map((r) => [r.predictionId, r.revenue30dKes]));
    for (const row of buyList!.rows) {
      expect(typeof row.revenue30dKes).toBe("number");
      expect(row.revenue30dKes).toBe(ownerRevenue.get(row.predictionId));
    }
  });

  it("shows a member the same trust words, and the same not-on-the-list grouping", async () => {
    const [member, owner] = await Promise.all([
      getBuyList(seeded.tenantId, { canViewCosts: false }),
      getBuyList(seeded.tenantId, { canViewCosts: true }),
    ]);
    expect(member!.excluded.length).toBeGreaterThan(0); // vacuity guard

    // The trust layer is derived from sales history, variability and product
    // age — never from cost — so it is identical for both roles. Asserted field
    // by field rather than relying on costNumbers(), which only matches keys
    // ending in "Kes" and would miss a cost smuggled in under another name.
    const ownerTrust = new Map(
      [...owner!.rows, ...owner!.excluded].map((r) => [
        r.predictionId,
        { c: r.confidence, s: r.coldStart, b: r.borrowedFromTitle },
      ])
    );
    for (const row of [...member!.rows, ...member!.excluded]) {
      expect(ownerTrust.get(row.predictionId)).toEqual({
        c: row.confidence,
        s: row.coldStart,
        b: row.borrowedFromTitle,
      });
    }
    expect(costNumbers(member)).toEqual([]);

    // Group membership is the same partition for both roles. A grouping that
    // differed by cost visibility would be a cost figure by another route —
    // the same defect the budget-split partition test guards against.
    const groupFor = (list: Awaited<ReturnType<typeof getBuyList>>) =>
      new Map(list!.excluded.map((r) => [r.predictionId, r.reason]));
    expect(groupFor(member)).toEqual(groupFor(owner));
  });

  it("never tells a money-blind member a product's cost exceeds its price", async () => {
    // `plannable` carries no number, but the screen turns it into sentences that
    // are entirely about cost — "cost is above the selling price", "no unit cost
    // on file". A member reading those has learned a cost fact, which is the same
    // leak-by-derivation the cost-moved flag is guarded against.
    const [member, owner] = await Promise.all([
      getBuyList(seeded.tenantId, { canViewCosts: false }),
      getBuyList(seeded.tenantId, { canViewCosts: true }),
    ]);

    expect(member!.rows.length + member!.excluded.length).toBeGreaterThan(0); // vacuity guard
    for (const row of [...member!.rows, ...member!.excluded]) {
      expect(row.plannable, row.sku).toBe("ok");
    }
    // The section whose only purpose is to report broken cost data is gone.
    expect(member!.excluded.some((r) => r.reason === "unplannable")).toBe(false);
    // Same products either way — this redacts a field, it does not hide rows.
    expect(new Set(member!.rows.map((r) => r.predictionId))).toEqual(
      new Set(owner!.rows.map((r) => r.predictionId))
    );
  });

  it("orders a member's buy list without costs: same rows, cost-free ranking", async () => {
    // Redaction nulls the line total but not the position it put the row in.
    // Inside a tie-group (same urgency, same days to stockout) the owner's order
    // IS the cost order, and recommendedQty is visible to everyone — so a member
    // could divide one by the other. The member's list is ranked on quantity and
    // SKU instead, and the urgency/stockout ordering that decides what to buy
    // first is untouched.
    const member = await getBuyList(seeded.tenantId, { canViewCosts: false });
    const rows = member!.rows;
    expect(rows.length).toBeGreaterThan(1);
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1]!;
      const row = rows[i]!;
      const sameGroup =
        prev.urgency === row.urgency && prev.daysUntilStockout === row.daysUntilStockout;
      if (!sameGroup) continue;
      expect(
        prev.recommendedQty > row.recommendedQty ||
          (prev.recommendedQty === row.recommendedQty && prev.sku.localeCompare(row.sku) <= 0),
        `${prev.sku} before ${row.sku}`
      ).toBe(true);
    }

    // The same holds for a list fetched WITH costs and redacted on the way out —
    // the path the cover-horizon and uplift actions take.
    const ownerList = await getBuyList(seeded.tenantId, { canViewCosts: true });
    const redacted = redactBuyList(ownerList!, false);
    expect(redacted.rows.map((r) => r.predictionId)).toEqual(rows.map((r) => r.predictionId));
    expect(costNumbers(redacted)).toEqual([]);
  });

  it("budget split is withheld from a member, not merely stripped of its figures", async () => {
    const ownerList = await getBuyList(seeded.tenantId, { canViewCosts: true });
    const split = splitByBudget(ownerList!.rows, 100_000);
    expect(split.funded.length).toBeGreaterThan(0); // the test would be vacuous otherwise

    const redacted = redactBudgetSplit(split, false);
    expect(redacted.fundedCostKes).toBeNull();
    expect(redacted.deferredCostKes).toBeNull();
    expect(redacted.deferredAtRiskKes).toBeNull();
    expect(redacted.leftoverKes).toBeNull();
    expect(redacted.overBudgetKes).toBeNull();
    expect(redacted.budgetKes).toBe(100_000); // the member's own input survives
    expect(costNumbers(redacted)).toEqual([]);
    // The partition is the leak: which rows fit under a cap answers a question
    // about their costs, and re-asking with different caps bisects each one. So
    // no partition comes back at all, flagged for the caller to explain.
    expect(redacted.withheld).toBe(true);
    expect(redacted.funded).toEqual([]);
    expect(redacted.deferred).toEqual([]);
    expect(redacted.checkCost).toEqual([]);

    // canViewCosts passes the split through untouched.
    expect(redactBudgetSplit(split, true)).toBe(split);
  });

  it("catalogue view receives only redacted rows in its serialized props", async () => {
    // The server table hands the (redacted) rows to the client CatalogueView —
    // that prop boundary is exactly what Next serializes into the client bundle,
    // so a money-blind member's rows must carry no cost numbers.
    const tree = await CatalogueTable({ tenantId: seeded.tenantId, canViewCosts: false, query: DEFAULT_QUERY });
    const views = findElements(tree, CatalogueView);
    expect(views).toHaveLength(1);
    const props = (views[0] as { props: unknown }).props;
    expect(costNumbers(props)).toEqual([]);

    const ownerTree = await CatalogueTable({ tenantId: seeded.tenantId, canViewCosts: true, query: DEFAULT_QUERY });
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
      ShelfHealth({ tenantId: seeded.tenantId, canViewCosts: false, currency: "KES" }).then(renderToStaticMarkup),
      ShelfHealth({ tenantId: seeded.tenantId, canViewCosts: true, currency: "KES" }).then(renderToStaticMarkup),
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
    // The idle-capital page is ranked and then cut, so the ranking key is part
    // of the payload: on-hand units for a member, never cash at rest.
    const units = member.cashRows.map((r) => r.onHandUnits);
    expect(units).toEqual([...units].sort((a, b) => b - a));

    const owner = await getInsightsOverview(seeded.tenantId, { canViewCosts: true });
    expect(costNumbers(owner).length).toBeGreaterThan(0);
    const cash = owner.cashRows.map((r) => r.cashKes ?? 0);
    expect(cash).toEqual([...cash].sort((a, b) => b - a)); // the owner's ranking is unchanged
  });

  it("costs screen: a cost move and its percentage never reach a member", async () => {
    const product = await prismaService.product.findFirstOrThrow({
      where: { tenantId: seeded.tenantId, ...BUYABLE_PRODUCT_WHERE },
      select: { id: true, costMovedPct: true, costMovedAt: true },
    });
    await prismaService.product.update({
      where: { id: product.id },
      data: { costMovedPct: 30, costMovedAt: new Date() },
    });
    try {
      const owner = await getCostMovedAlerts(seeded.tenantId, { canViewCosts: true });
      expect(owner.some((a) => a.productId === product.id && a.movedPct === 30)).toBe(true);

      // A signed buying-price delta is a cost figure, and the row's presence is
      // itself one ("this product's cost jumped past the threshold") — so the
      // member gets no rows, not rows with one field nulled.
      const member = await getCostMovedAlerts(seeded.tenantId, { canViewCosts: false });
      expect(member).toEqual([]);

      const memberHtml = renderToStaticMarkup(<CostMovedList alerts={member} canManage={false} />);
      expect(memberHtml).not.toContain("30%");
      expect(memberHtml).not.toContain("rose");
      const ownerHtml = renderToStaticMarkup(<CostMovedList alerts={owner} canManage={false} />);
      expect(ownerHtml).toContain("30%");
    } finally {
      await prismaService.product.update({
        where: { id: product.id },
        data: { costMovedPct: product.costMovedPct, costMovedAt: product.costMovedAt },
      });
    }
  });

  it("costs screen: the coverage tile keeps its revenue share from a member", async () => {
    // Found by the manifest check below — this getter had no money-blind row
    // anywhere. `trustedRevenuePct` is the share of trailing revenue carried by
    // products whose cost we trust: a weighting of costs by money, and the one
    // figure on the tile that a member must not have.
    const [member, owner] = await Promise.all([
      getCostCoverage(seeded.tenantId, { canViewCosts: false }),
      getCostCoverage(seeded.tenantId, { canViewCosts: true }),
    ]);
    expect(member.trustedRevenuePct).toBeNull();
    expect(owner.trustedRevenuePct).not.toBeNull(); // vacuity guard
    expect(costNumbers(member)).toEqual([]);

    // The rest of the tile is the same for both, on purpose: how many products
    // have a cost on file at all is a data-completeness fact about the
    // workspace, naming no product and carrying no figure. Asserted so the
    // choice is visible rather than assumed — if it should tighten, this is the
    // line that changes.
    expect(member.products).toBe(owner.products);
    expect(member.trustedProductPct).toBe(owner.trustedProductPct);
    expect(member.sourceSplit).toEqual(owner.sourceSplit);
  });

  it("notification feed: cost alerts stay off a member's bell, badge included", async () => {
    const fresh = await prismaService.notification.create({
      data: {
        tenantId: seeded.tenantId,
        kind: "cost_moved",
        title: "Vitamin C Serum — cost needs a look",
        body: "A synced cost jumped sharply — margins were recalculated.",
      },
    });
    // A row written before the figure came out of the title: still stored, still
    // unread. Rewording the writer does nothing for it — the feed filter does.
    const legacy = await prismaService.notification.create({
      data: { tenantId: seeded.tenantId, kind: "cost_moved", title: "Vitamin C Serum cost rose +30%" },
    });
    try {
      const owner = await listNotifications(seeded.tenantId, { canViewCosts: true, limit: 50 });
      const ownerIds = new Set(owner.items.map((n) => n.id));
      expect(ownerIds.has(fresh.id)).toBe(true);
      expect(ownerIds.has(legacy.id)).toBe(true);

      const member = await listNotifications(seeded.tenantId, { canViewCosts: false, limit: 50 });
      expect(member.items.some((n) => n.kind === "cost_moved")).toBe(false);
      expect(member.items.map((n) => n.title).join(" ")).not.toContain("%");

      // The badge counts what the feed shows, so the two can't contradict.
      const hiddenUnread = await prismaService.notification.count({
        where: { tenantId: seeded.tenantId, kind: "cost_moved", readAt: null },
      });
      const ownerUnread = await getUnreadCount(seeded.tenantId, { canViewCosts: true });
      const memberUnread = await getUnreadCount(seeded.tenantId, { canViewCosts: false });
      expect(ownerUnread - memberUnread).toBe(hiddenUnread);
    } finally {
      await prismaService.notification.deleteMany({
        where: { id: { in: [fresh.id, legacy.id] } },
      });
    }
  });

  it("transfers: the value on the move is masked, the quantities are not", async () => {
    // The seeded warehouse only backs slow lines the shop is already covered on,
    // so give a fast mover real backstock — otherwise there is nothing to move
    // and the test proves nothing.
    const warehouse = await prismaService.location.findFirstOrThrow({
      where: { tenantId: seeded.tenantId, locationType: "warehouse" },
      select: { id: true },
    });
    const product = await prismaService.product.findFirstOrThrow({
      where: { tenantId: seeded.tenantId, sku: "ARI-MJ-90" },
      select: { id: true },
    });
    const before = await prismaService.inventoryLevel.findUniqueOrThrow({
      where: { locationId_productId: { locationId: warehouse.id, productId: product.id } },
      select: { onHand: true, available: true },
    });
    // Both move together — a warehouse holding 200 with only its old available
    // figure would be 200 units nothing is allowed to shift.
    await prismaService.inventoryLevel.update({
      where: { locationId_productId: { locationId: warehouse.id, productId: product.id } },
      data: { onHand: 200, available: 200 },
    });

    const args = { tenantId: seeded.tenantId, fromLocationId: warehouse.id, coverDays: 14 };
    const payload = await getDistributionProposal(seeded.tenantId, {
      fromLocationId: warehouse.id,
      coverDays: 14,
      canViewCosts: false,
    });
    expect(payload!.lines.length).toBeGreaterThan(0); // the test would be vacuous otherwise
    expect(payload!.totalValueKes).toBeNull();
    for (const line of payload!.lines) expect(line.valueKes).toBeNull();
    expect(costNumbers(payload)).toEqual([]);
    // Units and run rates are operational facts, not money — they stay.
    expect(payload!.totalUnits).toBeGreaterThan(0);

    const member = renderToStaticMarkup(
      await ProposalView({ ...args, canViewCosts: false, canPlan: false })
    );
    expect(kesDigits(member)).toHaveLength(0);
    expect(member).toContain(MASK);

    const owner = renderToStaticMarkup(
      await ProposalView({ ...args, canViewCosts: true, canPlan: false })
    );
    expect(kesDigits(owner).length).toBeGreaterThan(0);
    expect(owner).not.toContain(MASK);

    // Same plan either way: redaction changes the money, never the decision.
    const ownerPayload = await getDistributionProposal(seeded.tenantId, {
      fromLocationId: warehouse.id,
      coverDays: 14,
      canViewCosts: true,
    });
    expect(payload!.lines.map((l) => `${l.productId}:${l.toLocationId}:${l.qty}`)).toEqual(
      ownerPayload!.lines.map((l) => `${l.productId}:${l.toLocationId}:${l.qty}`)
    );

    await prismaService.inventoryLevel.update({
      where: { locationId_productId: { locationId: warehouse.id, productId: product.id } },
      data: { onHand: before.onHand, available: before.available },
    });
  });
});

describe("export column gating", () => {
  it("cost columns exist only for cost viewers", () => {
    const memberHeaders = catalogueExportColumns(false, "KES").map((c) => c.header);
    // Supplier and lead time are not cost facts — a money-blind member buys from
    // the same suppliers and waits the same days, so both stay in their export.
    expect(memberHeaders).toEqual([
      "Product",
      "SKU",
      "Supplier",
      "Lead (days)",
      "On hand",
      "In warehouse",
      "Days cover",
      "Status",
    ]);
    const ownerHeaders = catalogueExportColumns(true, "KES").map((c) => c.header);
    expect(ownerHeaders).toContain("Unit cost (KES)");
    expect(ownerHeaders).toContain("Stock value (KES)");
    // The workspace's own currency labels the money columns.
    expect(catalogueExportColumns(true, "USD").map((c) => c.header)).toContain("Unit cost (USD)");
  });

  it("the transfer pick list carries value only for cost viewers", () => {
    expect(transferExportColumns(false, "KES").map((c) => c.header)).toEqual([
      "Product",
      "SKU",
      "To",
      "Move",
      "Sells/day",
      "Cover before",
      "Cover after",
    ]);
    expect(transferExportColumns(true, "KES").map((c) => c.header)).toContain("Value (KES)");
    expect(transferExportColumns(true, "USD").map((c) => c.header)).toContain("Value (USD)");
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
    orderQty: 10,
    overriddenQty: null,
    runRatePerDay: 1.5,
    moq: 1,
    leadFloored: false,
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
    confidence: "sure",
    coldStart: null,
    borrowedFromTitle: null,
  });

  const mkList = (rows: BuyListRow[]): BuyList => ({
    forecastRunId: "run1",
    runDate: new Date(),
    rows,
    excluded: [],
    totalPredicted: rows.length,
    totalCostKes: rows.reduce((sum, r) => sum + (r.lineTotalKes ?? 0), 0),
  });

  it("nulls costs for a member but keeps the member-visible trailing revenue", () => {
    const member = redactBuyList(mkList([mkRow(5000)]), false);
    // Cost/margin figures go dark for a member...
    expect(member.rows[0]!.lineTotalKes).toBeNull();
    expect(member.rows[0]!.atRiskKes).toBeNull();
    expect(member.totalCostKes).toBeNull();
    // ...but actual trailing revenue is a sales figure — it stays.
    expect(member.rows[0]!.revenue30dKes).toBe(5000);
    // Non-money planning fields survive too.
    expect(member.rows[0]!.runRatePerDay).toBe(1.5);
    expect(member.rows[0]!.abc).toBe("A");
    // No non-revenue *Kes cost number leaks (revenue30dKes is allowlisted).
    expect(costNumbers(member.rows)).toEqual([]);
    const ownerList = mkList([mkRow(5000)]);
    expect(redactBuyList(ownerList, true)).toBe(ownerList);
  });

  it("hides a cost verdict from a member, and keeps it for the owner", () => {
    // "Cost is above the selling price — restocking this loses money" is a cost
    // fact even though `plannable` holds no number, and it rendered for every
    // role. Redact the field; do not remove the row.
    const broken: BuyListRow = { ...mkRow(0), plannable: "cost-exceeds-price" };
    const ordered: BuyListRow = { ...mkRow(0), predictionId: "p2", plannable: "ok" };
    const owner: BuyList = {
      ...mkList([broken, ordered]),
      excluded: [
        { ...broken, predictionId: "x1", reason: "unplannable" },
        { ...ordered, predictionId: "x2", reason: "covered" },
      ],
    };

    const member = redactBuyList(owner, false);
    expect(member.rows.map((r) => r.plannable)).toEqual(["ok", "ok"]);
    // The group that exists only to report broken cost data is dropped whole —
    // a redacted version would be a heading with nothing to say.
    expect(member.excluded.map((r) => r.reason)).toEqual(["covered"]);
    expect(member.rows).toHaveLength(2); // rows are redacted, never hidden

    // The owner keeps the verdict — this is redaction, not deletion.
    expect(owner.rows[0]!.plannable).toBe("cost-exceeds-price");
    expect(owner.excluded.some((r) => r.reason === "unplannable")).toBe(true);
  });

  it("an owner-overridden row keeps its quantity but still hides the line total from a member", () => {
    // The override changes the qty (and therefore the line total). The qty is
    // operational and stays; the money it implies is redacted like any other.
    const row: BuyListRow = { ...mkRow(0), overriddenQty: 8, recommendedQty: 8, lineTotalKes: 800 };
    const member = redactBuyList(mkList([row]), false);
    expect(member.rows[0]!.overriddenQty).toBe(8);
    expect(member.rows[0]!.recommendedQty).toBe(8);
    expect(member.rows[0]!.lineTotalKes).toBeNull();
    expect(costNumbers(member.rows)).toEqual([]);
  });

  it("re-orders a redacted tie-group on cost-free keys, never on the line total", () => {
    // Three rows the owner's comparator can only separate by line total: same
    // urgency, same days to stockout. The owner sees them biggest-line first;
    // a member must not, because dividing that order by the visible quantities
    // recovers the unit costs.
    const tie = (sku: string, qty: number, unitCostKes: number): BuyListRow => ({
      ...mkRow(0),
      predictionId: sku,
      productId: sku,
      sku,
      recommendedQty: qty,
      orderQty: qty,
      unitCostKes,
      lineTotalKes: qty * unitCostKes,
    });
    const cheapBig = tie("AAA", 20, 10); // line 200
    const dearSmall = tie("BBB", 5, 300); // line 1500
    const middle = tie("CCC", 20, 40); // line 800

    const owner = mkList([cheapBig, dearSmall, middle]);
    const member = redactBuyList(owner, false);
    // Quantity desc, then SKU — nothing in this order tracks the line totals.
    expect(member.rows.map((r) => r.sku)).toEqual(["AAA", "CCC", "BBB"]);
    expect(costNumbers(member.rows)).toEqual([]);
  });

  it("withholds the budget partition from a member, but not from a cost viewer", () => {
    const split = splitByBudget([mkRow(0), { ...mkRow(0), predictionId: "p2", sku: "SKU2" }], 1500);
    // The owner's split still answers the question in full.
    expect(split.funded.length + split.deferred.length).toBe(2);
    // The member's carries no partition to bisect a cost out of.
    const member = redactBudgetSplit(split, false);
    expect(member.withheld).toBe(true);
    expect(member.funded).toEqual([]);
    expect(member.deferred).toEqual([]);
    expect(member.fundedCostKes).toBeNull();
    expect(costNumbers(member)).toEqual([]);
  });
});
