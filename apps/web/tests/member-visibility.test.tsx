import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prismaService } from "@wezesha/db";
import { seedDev, type SeedResult } from "../../../packages/db/scripts/seed-dev";
import { hasPermission } from "../lib/auth/permissions";
import { MoneyGate } from "../components/money-gate";

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

/**
 * Money-blindness proof for the live screens: rendered with the MEMBER
 * wiring (canViewCosts=false, exactly what the pages derive from
 * hasPermission(membership, "view_costs")), no KES cost figure survives in the
 * HTML — dead-stock cost, order costs, and stock-value-at-cost all mask, while
 * revenue (a sales figure) stays visible. Skips without the local database.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

/** Every "KES <digits>" occurrence — a real money figure reaching the markup. */
const kesDigits = (html: string) => html.match(/KES\s[\d][\d,.]*/g) ?? [];
const MASK = "KES •••";

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
});
