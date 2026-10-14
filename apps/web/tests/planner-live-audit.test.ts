import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

/**
 * The planner against a real shop's numbers, across every combination.
 *
 * Skipped unless PLANNER_SNAPSHOT points at a JSON export made with
 * scripts/planner-snapshot.sql. The export is fed to the REAL getBuyList and
 * splitByBudget through an in-memory stand-in for the database, so this is the
 * code production runs — only the storage is swapped.
 *
 * Every budget × filter × cover combination is checked against rules a correct
 * plan must obey, and a readable report is written beside the snapshot
 * (`<snapshot>.report.md`) so a person can judge whether the answers make sense.
 */

const SNAPSHOT = process.env.PLANNER_SNAPSHOT;

type Snap = {
  tenant: { id: string; name: string; currency: string };
  runDate: string;
  predictions: Array<Record<string, unknown> & {
    productId: string;
    forecastRunId: string;
    regime: string | null;
    finalForecast30d: number;
    product: {
      sku: string;
      title: string;
      currentStock: number;
      onOrder: number;
      leadTimeDays: number | null;
      supplier: { name: string; leadTimeAvgDays: number | null; moq: number } | null;
    };
  }>;
  overrides: { productId: string; qty: number }[];
  revenue30d: { productId: string; revenueKes: number }[];
  onTheWayProductIds: string[] | null;
  poLines: { productId: string; quantity: number; receivedQty: number; status: string }[];
};

const snap: Snap | null = SNAPSHOT
  ? (() => {
      const raw = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
      // Supabase's editor exports either the bare value or [{ snapshot: … }].
      return (Array.isArray(raw) ? raw[0].snapshot : raw.snapshot ?? raw) as Snap;
    })()
  : null;

vi.mock("@wezesha/forecast-run", async () => {
  const { pickBestRun } = await import("@wezesha/forecast");
  return {
    latestForecastRun: async () => {
      if (!snap) return null;
      const counts = new Map<string, number>();
      const ai = new Set<string>();
      for (const p of snap.predictions) {
        counts.set(p.forecastRunId, (counts.get(p.forecastRunId) ?? 0) + 1);
        if (p.regime && ["sarima", "tsb", "cold_start"].includes(p.regime)) ai.add(p.forecastRunId);
      }
      const id = pickBestRun([...counts].map(([forecastRunId, count]) => ({ forecastRunId, count })), ai);
      return id ? { forecastRunId: id, runDate: new Date(snap.runDate) } : null;
    },
  };
});

vi.mock("@wezesha/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@wezesha/db")>();
  const fake = {
    prediction: {
      findMany: async ({ where }: { where: { forecastRunId: string } }) =>
        (snap?.predictions ?? [])
          .filter((p) => p.forecastRunId === where.forecastRunId)
          .map((p) => ({ ...p, runDate: new Date(p.runDate as string) })),
    },
    productPlanOverride: { findMany: async () => snap?.overrides ?? [] },
    salesHistory: {
      groupBy: async () =>
        (snap?.revenue30d ?? []).map((r) => ({ productId: r.productId, _sum: { revenueKes: r.revenueKes } })),
    },
    order: {
      findMany: async () => (snap?.onTheWayProductIds ?? []).map((productId) => ({ productId })),
    },
    purchaseOrderLine: {
      findMany: async ({ where }: { where: { purchaseOrder: { status: string | { in: string[] } } } }) => {
        const s = where.purchaseOrder.status;
        const wanted = typeof s === "string" ? [s] : s.in;
        return (snap?.poLines ?? []).filter((l) => wanted.includes(l.status));
      },
    },
    product: { findMany: async () => [] },
  };
  return { ...real, prismaForTenant: () => fake };
});

const { getBuyList, splitByBudget } = await import("../lib/data/plan");
const { filterBuyListRows, EMPTY_SCOPE, leadBandFor } = await import("../app/(shell)/plan/scope");
type ScopeSelection = import("../app/(shell)/plan/scope").ScopeSelection;
type BuyListRow = import("../lib/data/plan").BuyListRow;

const COVERS: (number | null)[] = [null, 7, 14, 21, 30, 60];

describe.skipIf(!snap)("planner on live numbers", () => {
  it("every budget × filter × cover combination obeys the planner's rules", async () => {
    const s = snap!;
    const tenantId = s.tenant.id;
    const productById = new Map(s.predictions.map((p) => [p.productId, p]));
    const overridden = new Set(s.overrides.map((o) => o.productId));
    const measuredLead = (productId: string): number | null => {
      const p = productById.get(productId)?.product;
      return p?.leadTimeDays ?? p?.supplier?.leadTimeAvgDays ?? null;
    };

    const failures: string[] = [];
    const fail = (combo: string, msg: string) => {
      if (failures.length < 200) failures.push(`${combo}: ${msg}`);
    };
    const report: string[] = [`# Planner audit — ${s.tenant.name}`, "", `Forecast run of ${s.runDate}.`, ""];

    // ---- Lists at each cover ------------------------------------------------
    const lists = new Map<number | null, BuyListRow[]>();
    for (const cover of COVERS) {
      const list = await getBuyList(tenantId, { canViewCosts: true, coverDays: cover ?? undefined });
      expect(list, "the snapshot must contain a forecast run").not.toBeNull();
      lists.set(cover, list!.rows);
    }
    const base = lists.get(null)!;
    const plannable = (rows: BuyListRow[]) => rows.filter((r) => r.plannable === "ok" && (r.lineTotalKes ?? 0) > 0);
    const totalCost = plannable(base).reduce((n, r) => n + (r.lineTotalKes ?? 0), 0);

    // ---- Scopes to test -----------------------------------------------------
    const count = (key: (r: BuyListRow) => string | null) => {
      const m = new Map<string, number>();
      for (const r of base) {
        const k = key(r);
        if (k) m.set(k, (m.get(k) ?? 0) + 1);
      }
      return [...m].sort((a, b) => b[1] - a[1]);
    };
    const scopes: [string, ScopeSelection][] = [["whole shop", EMPTY_SCOPE]];
    for (const [abc] of count((r) => r.abc)) scopes.push([`class ${abc}`, { ...EMPTY_SCOPE, abc: [abc] }]);
    for (const [band] of count((r) => leadBandFor(r.leadDays)))
      scopes.push([`lead ${band}`, { ...EMPTY_SCOPE, leadBand: [band as "fast"] }]);
    for (const [sup] of count((r) => r.supplierName).slice(0, 6))
      scopes.push([`supplier ${sup}`, { ...EMPTY_SCOPE, supplier: [sup] }]);
    const [topSup] = count((r) => r.supplierName)[0] ?? [];
    if (topSup) scopes.push([`supplier ${topSup} + class A`, { ...EMPTY_SCOPE, supplier: [topSup], abc: ["A"] }]);

    const fractions = [0, 0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5];

    report.push(
      `**${base.length}** products on the list, **${plannable(base).length}** plannable, ` +
        `full list costs **${Math.round(totalCost).toLocaleString()} ${s.tenant.currency}** at the plan's own quantities.`,
      ""
    );

    let combos = 0;
    for (const cover of COVERS) {
      const rowsAtCover = lists.get(cover)!;
      for (const [scopeName, scope] of scopes) {
        const scoped = filterBuyListRows(rowsAtCover, scope);
        const scopedCost = plannable(scoped).reduce((n, r) => n + (r.lineTotalKes ?? 0), 0);
        let prevFunded = -1;
        for (const f of fractions) {
          // Rounded UP: a cost like 2,991.38 makes a rounded-down "100%" budget a
          // few cents short of the list, which would read as a planner failure.
          const budget = Math.ceil(scopedCost * f);
          const combo = `cover=${cover ?? "plan"} · ${scopeName} · budget=${budget}`;
          combos++;
          const split = splitByBudget(scoped, budget, { strict: true });
          const funded = split.funded;
          const deferred = split.deferred;

          // 1. A hard cap is a hard cap.
          if ((split.fundedCostKes ?? 0) > budget + 0.5) fail(combo, `spent ${split.fundedCostKes} over budget`);
          // 2. Every row the filter allows is accounted for, and nothing else.
          const seen = funded.length + deferred.length + split.checkCost.length;
          const expected = scoped.filter((r) => r.plannable !== "ok" || (r.lineTotalKes ?? 0) > 0).length;
          if (seen !== expected) fail(combo, `${expected} rows in filter, split accounts for ${seen}`);
          for (const r of [...funded, ...deferred])
            if (!filterBuyListRows([r], scope).length) fail(combo, `${r.sku} is outside the filter`);
          // 3. Nothing affordable is left behind — except lines that can wait,
          //    which are held while any must-order-now line is unfunded.
          const urgentUnfunded = deferred.some((d) => d.tier !== "can_wait");
          for (const d of deferred)
            if (!(urgentUnfunded && d.tier === "can_wait") && (d.lineTotalKes ?? 0) <= (split.leftoverKes ?? 0))
              fail(combo, `${d.sku} (${d.lineTotalKes}) deferred with ${split.leftoverKes} left over`);
          // 3b. No line that can wait is funded while a must-order line is not.
          if (urgentUnfunded && funded.some((r) => r.tier === "can_wait"))
            fail(combo, "a line that can wait was funded while an urgent one was not");
          // 4. Priority: a line funded ahead of a deferred one never has a later
          //    order deadline unless the deferred one simply didn't fit then.
          const firstDeferred = deferred[0];
          if (firstDeferred) {
            const due = Math.max(0, firstDeferred.daysLeftToOrder);
            const laterFunded = funded.filter((r) => Math.max(0, r.daysLeftToOrder) > due);
            const cheaperThanIt = laterFunded.every((r) => (r.lineTotalKes ?? 0) < (firstDeferred.lineTotalKes ?? 0));
            if (!cheaperThanIt) fail(combo, `a later-deadline line was funded ahead of ${firstDeferred.sku}`);
          }
          // 5. Full budget funds everything.
          if (f >= 1 && deferred.length > 0) fail(combo, `${deferred.length} deferred with the whole list's cost available`);
          // 6. More money never funds fewer lines' worth of spend.
          if ((split.fundedCostKes ?? 0) + 0.5 < prevFunded)
            fail(combo, `spent ${split.fundedCostKes}, less than ${prevFunded} at a smaller budget`);
          prevFunded = split.fundedCostKes ?? 0;
        }
      }
    }

    // ---- Cover and lead time, per product -----------------------------------
    const byCover = COVERS.filter((c): c is number => c != null);
    let leadChecked = 0;
    for (let i = 1; i < byCover.length; i++) {
      const lo = new Map(lists.get(byCover[i - 1]!)!.map((r) => [r.productId, r]));
      for (const hi of lists.get(byCover[i]!)!) {
        const a = lo.get(hi.productId);
        if (a && !overridden.has(hi.productId) && hi.recommendedQty < a.recommendedQty)
          fail(`cover ${byCover[i - 1]}→${byCover[i]}`, `${hi.sku} qty fell ${a.recommendedQty}→${hi.recommendedQty}`);
      }
    }
    for (const cover of byCover) {
      for (const r of lists.get(cover)!) {
        if (overridden.has(r.productId) || r.recommendedQty <= 0) continue;
        const p = productById.get(r.productId)!;
        const rate = p.finalForecast30d / 30;
        if (rate <= 0) continue;
        const lead = measuredLead(r.productId) ?? 0;
        const onArrival = r.onHandUnits + r.onOrderUnits + r.recommendedQty - rate * lead;
        const daysAfter = onArrival / rate;
        leadChecked++;
        if (daysAfter < cover - 1)
          fail(
            `cover ${cover}`,
            `${r.sku} lands with ${daysAfter.toFixed(1)} days (lead ${lead}d, rate ${rate.toFixed(2)}/d, qty ${r.recommendedQty})`
          );
      }
    }

    // ---- Human-readable report ---------------------------------------------
    const fmt = (n: number | null) => (n == null ? "—" : Math.round(n).toLocaleString());
    const showSplit = (title: string, rows: BuyListRow[], budget: number) => {
      const split = splitByBudget(rows, budget, { strict: true });
      report.push(
        `### ${title}`,
        "",
        `Budget ${fmt(budget)} → funded ${split.funded.length} lines for ${fmt(split.fundedCostKes)}, ` +
          `deferred ${split.deferred.length} (${fmt(split.deferredCostKes)}), ${fmt(split.leftoverKes)} left.`,
        "",
        "| # | Product | Class | Supplier | Lead | In stock | Sells/day | Days left | Order by (days) | Qty | Cost | Status |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|"
      );
      const all = [...split.funded.map((r) => ["funded", r] as const), ...split.deferred.map((r) => ["deferred", r] as const)];
      all.slice(0, 15).forEach(([status, r], i) =>
        report.push(
          `| ${i + 1} | ${r.title.slice(0, 40)} | ${r.abc ?? "—"} | ${r.supplierName ?? "—"} | ${r.leadDays}d | ${fmt(r.onHandUnits)} | ${r.runRatePerDay.toFixed(2)} | ${r.daysUntilStockout ?? "∞"} | ${r.daysLeftToOrder} | ${r.recommendedQty} | ${fmt(r.lineTotalKes)} | ${status} |`
        )
      );
      report.push("");
    };
    const at21 = lists.get(21)!;
    const cost21 = plannable(at21).reduce((n, r) => n + (r.lineTotalKes ?? 0), 0);
    report.push("## Same filter, different budgets (whole shop, 21 days cover)", "");
    for (const f of [0.1, 0.25, 0.5]) showSplit(`${Math.round(f * 100)}% of the full list`, at21, Math.round(cost21 * f));
    report.push("## Same budget, different filters (25% of each filter's list, 21 days cover)", "");
    for (const [name, scope] of scopes.slice(1, 8)) {
      const rows = filterBuyListRows(at21, scope);
      const c = plannable(rows).reduce((n, r) => n + (r.lineTotalKes ?? 0), 0);
      showSplit(name, rows, Math.round(c * 0.25));
    }
    report.push("## Cover days — one product per lead band", "");
    report.push("| Product | Lead | Sells/day | In stock | " + byCover.map((c) => `${c}d`).join(" | ") + " |");
    report.push("|---|---|---|---|" + byCover.map(() => "---").join("|") + "|");
    for (const band of ["fast", "medium", "slow"]) {
      const pick = base.find((r) => leadBandFor(r.leadDays) === band && measuredLead(r.productId) != null && !overridden.has(r.productId));
      if (!pick) continue;
      const qtys = byCover.map((c) => lists.get(c)!.find((r) => r.productId === pick.productId)?.recommendedQty ?? 0);
      report.push(`| ${pick.title.slice(0, 40)} | ${pick.leadDays}d | ${pick.runRatePerDay.toFixed(2)} | ${fmt(pick.onHandUnits)} | ${qtys.join(" | ")} |`);
    }
    report.push(
      "",
      `## Result`,
      "",
      `${combos} budget × filter × cover combinations and ${leadChecked} lead-time checks.`,
      failures.length ? `**${failures.length} problems:**\n\n- ${failures.join("\n- ")}` : "**No rule broken.**"
    );
    writeFileSync(`${SNAPSHOT}.report.md`, report.join("\n"));

    expect(failures, failures.slice(0, 20).join("\n")).toEqual([]);
  }, 120_000);
});
