import { NextResponse } from "next/server";
import { BUYABLE_PRODUCT_WHERE, prismaForTenant } from "@wezesha/db";
import { activeMembership, getSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { getTodayMetrics } from "@/lib/data/today";
import { renderReportPdf, type ReportPdfData } from "@/lib/reports/report-pdf";
import { withCapture } from "@/lib/observability/wrap";

// react-pdf needs the Node runtime (not edge).
export const runtime = "nodejs";
export const maxDuration = 30;

const DAY_MS = 86_400_000;

/**
 * GET /api/reports/pdf — a one-page shop performance report.
 *
 * Session-guarded and scoped to the caller's active membership; any authenticated
 * member may export (there is no separate export permission). Cost figures —
 * capital tied up, dead-stock value — are dropped for a member without
 * `view_costs`, so a money-blind role's PDF never carries them.
 *
 * The headline counts (revenue, stockouts, dead stock) come from getTodayMetrics
 * so this report and the Today/Insights screens can never disagree. ABC mix,
 * capital and the top-movers table are the report's own, read on the same
 * RLS-enforced tenant client.
 */
export const GET = withCapture(
  async () => {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const membership = await activeMembership(session.user.id);
    if (!membership) {
      return NextResponse.json({ error: "no workspace" }, { status: 403 });
    }

    const canSeeCosts = hasPermission(membership, "view_costs");
    const tenantId = membership.tenantId;
    const db = prismaForTenant(tenantId);
    const since30 = new Date(Date.now() - 30 * DAY_MS);

    const [today, products, sales30] = await Promise.all([
      getTodayMetrics(tenantId, { canViewCosts: canSeeCosts }),
      db.product.findMany({
        where: { ...BUYABLE_PRODUCT_WHERE },
        select: { id: true, title: true, sku: true, costKes: true, currentStock: true, abcCategory: true },
      }),
      db.salesHistory.groupBy({
        by: ["productId"],
        where: { date: { gte: since30 } },
        _sum: { quantity: true, revenueKes: true },
      }),
    ]);

    // ABC mix + capital tied up, walked once over the buyable catalogue.
    const abc = { A: 0, B: 0, C: 0 };
    let capital = 0;
    for (const p of products) {
      capital += p.currentStock * p.costKes;
      if (p.abcCategory === "A") abc.A++;
      else if (p.abcCategory === "B") abc.B++;
      else if (p.abcCategory === "C") abc.C++;
    }

    const last30Rev = sales30.reduce((sum, s) => sum + (s._sum.revenueKes ?? 0), 0);

    const productById = new Map(products.map((p) => [p.id, p]));
    const topMovers = sales30
      .map((s) => ({ p: productById.get(s.productId), rev: s._sum.revenueKes ?? 0, qty: s._sum.quantity ?? 0 }))
      .filter((x): x is { p: NonNullable<typeof x.p>; rev: number; qty: number } => x.p != null)
      .sort((a, b) => b.rev - a.rev)
      .slice(0, 10)
      .map((x) => ({ title: x.p.title, sku: x.p.sku, qty: Math.round(x.qty), rev: x.rev }));

    const data: ReportPdfData = {
      shop: {
        name: membership.tenant.name,
        timezone: membership.tenant.timezone,
        currency: membership.tenant.currency,
      },
      generatedAt: new Date(),
      canSeeCosts,
      last30Rev,
      capitalCost: canSeeCosts ? capital : null,
      abc,
      topMovers,
      deadStock: { count: today.deadStock.skus, valueKes: today.deadStock.costKes },
      stockoutCount: today.stockedOutProducts,
    };

    const pdf = await renderReportPdf(data);
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="report.pdf"`,
      },
    });
  },
  { route: "/api/reports/pdf", errorMessage: "report pdf build failed" }
);
