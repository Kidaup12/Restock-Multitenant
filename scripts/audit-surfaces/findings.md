# Stock, inventory, dashboard and reports comparison — 2026-10-05

Implementation follow-up: S3's current-surface eligibility gap is now fixed in the working tree. Today tiles/table and current Insights overview/matrix share `apps/web/lib/inventory/dead-stock.ts`, retain the14-observed-day guard, and resolve Shopify-created date then received date. Positive-quantity sales alone reset the last-sale clock. A linked `/inventory/position` report now ports the original chosen-window average/opening-position behavior with30/60/90 days, observation coverage, effective inbound and complete CSV/PDF exports. Audit findings below describe the investigated pre-fix state unless noted. Focused validation:16 tests passed,14 local-database cases skipped (no local database configured).

Scope: static trace of current multitenant working tree against `../_ref-wezesha-restock`, plus read-only execution of production pure functions. No production/database/network mutations or runtime database reconciliation. Line references below are relative to `Restock-Multitenant` unless prefixed `../`. Severity means purchasing/reporting impact; no security finding is implied.

Run `node scripts/audit-surfaces/evidence.mjs` from repo root. Five discrepancy fixtures pass, loading actual production pure functions by TypeScript transpilation with imports removed; no database modules are loaded. Inline numeric examples below are analytical unless explicitly marked reproduced.

## Confirmed actionable discrepancies

### S1 — High: email restock is not the multitenant planner

`apps/worker/src/owner-report.ts:499,513,521,527,542-556` reads stored recommended quantities, raw `Product.onOrder`, `finalForecast30d/30`, and only `product.active`/cost checks. The original has substantially the same logic at `../_ref-wezesha-restock/lib/reports/weekly-report.ts:183-242`. Porting its segmentation did not adapt it to the richer multitenant planner contract:

- Planner applies owner quantity overrides (`apps/web/lib/data/plan.ts:462-474,602`); report does not. Set an override from 8 to 20: email says order8, planner20. Override to0: email still recommends8.
- Planner applies supplier MOQ (`plan.ts:611,640`); report rounds recommendedQty only (`owner-report.ts:543`). Qty3 with MOQ12 costs 12 units in the planner and3 in email budget.
- Planner suppresses existing open orders and low-urgency slow movers (`plan.ts:340-356,668`); report only checks positive stored qty and cost (`owner-report.ts:527`). An order placed after the run can remain recommended in email.
- Planner reads `effectiveOnOrder` at `plan.ts:558`, Stock at `apps/web/lib/data/stock.ts:330`; worker reads raw inbound. **Reproduced**: Shopify onOrder0, outstanding sent PO40 -> Stock/Plan40 vs email0 (`packages/db/src/inbound.ts:50`).
- Plan displays baseline run rate `layer1Forecast30d/30` (`plan.ts:632`), email displays adjusted/sized `finalForecast30d/30` (`owner-report.ts:544`). Promo/model-adjusted forecast120 against baseline60 gives email4/day vs Plan2/day. This may be an intentional difference in concept, but the same run-rate label and critical-section thresholds obscure it.
- Plan comparator is ABC -> urgency -> runway (`plan.ts:288`); email section comparator ABC -> adjusted rate (`owner-report.ts:555`). The email comment claiming planner parity is inaccurate.

Recommended next step: shared tenant-neutral buy-list assembly consumed by both web and worker, with explicit baseline vs planned-demand fields. Do not copy more original email business logic without this adaptation.

### S2 — High: email warehouse transfers can allocate committed units

`apps/worker/src/owner-report.ts:695,714,717,732,743` selects and uses physical `onHand`, ignoring `available`. Web transfers select both and use `sellableUnits` (`apps/web/lib/data/transfers.ts:218,230,246`). This contradicts `packages/db/src/inventory.ts:42` quantity semantics.

**Reproduced through actual shared sizeTransfers:** warehouse onHand10, available2 (eight committed), empty branch at1/day, target14d -> email transfer10, UI transfer2. No change to sizing engine can fix the wrong input.

The email also estimates blended demand using only location-attributed sales/90 (`owner-report.ts:738`), while UI uses all-channel weighted/stockout-adjusted catalogue rate (`transfers.ts:243`) and attribution only for branch shares. A seller whose sales all have null location gets no email transfer, while UI can allocate using its destination-share fallback. This is a second confirmed code-path divergence; database prevalence is unknown.

### S3 — Medium: original new-product protection is still missing from current dead stock

Original `../_ref-wezesha-restock/lib/inventory/dead-stock.ts:44-58` protects never-sold products younger than60 days and those with unknown age. Current `apps/web/lib/data/today.ts:45-54` knows only last sale and observed stock days; no age is selected at `today.ts:86`. The recent 14-observed-stock-day protection does not restore the new-product rule.

**Reproduced:** one-day-old product, ten units, never sold, no snapshots -> original not-dead; multitenant Today dead. With14 in-stock observations a20-day-old never-sold product also becomes dead. Insights overview/matrix use equivalent missing-age logic (`apps/web/lib/data/insights.ts:203,1432`). PDF inherits Today.

### S4 — Medium: monthly email ignores configured dead-stock window

`apps/worker/src/owner-report.ts:305,331-336`: weekly mode uses trailing dead-stock weeks, monthly mode checks only `sold === 0`, despite taking `deadStockWindowDays`. This is inherited from original `../_ref-wezesha-restock/lib/metrics/stock-health.ts:259-266`, so blindly synchronizing originals preserves the issue.

**Reproduced:** sold Aug31, stock10 throughout September, configured90 days. September email counts dead1; Today on Oct5 counts healthy. This is not simply a different as-of date: no September date is90 days after Aug31. If monthly metric intentionally means "unsold this month", rename it; otherwise apply actual configured rolling window.

Weekly historical email also requires a prior sale in the loaded history (`owner-report.ts:293,331`), whereas current dead stock allows never-sold stock. The limited sales query (`owner-report.ts:425`) can omit the only old sale, excluding genuinely dead products. For a180-day configured dead window, its fixed12-week lookback cannot fully support the first periods. This needs targeted follow-up tests.

### S5 — High reporting risk: fully stocked-out bestseller disappears from email stockout count

`apps/worker/src/owner-report.ts:318` requires `sold > 0` in the same period before counting observed stockout or estimating lost revenue. Original carries the same rule (`../_ref-wezesha-restock/lib/metrics/stock-health.ts:236`).

**Reproduced:** A-class product sold14 previous week, all7 current days observed at zero, no current sales -> owner email0% stockouts and KES0 missed revenue. Web empty-shelf trend counts all empty observed product-days (`apps/web/lib/data/insights.ts:583-593`) ->100% for this sole product. The percentages are intentionally different measures (A/B SKUs that ran out versus product-days), so they should not normally reconcile numerically; nevertheless a full-period observed outage producing a reassuring zero is a distinct blind spot. Proposed fix requires defining whether the email measures "ran out while selling" or "was unavailable", and labelling it explicitly.

### S6 — Medium: observed-stock protection only applied to current dead-stock surfaces

Current Today applies >=14 stocked observations (`today.ts:51`), as do current Insights (`insights.ts:203,1432`). Historical deadStockByWeek (`insights.ts:702-750`) and monthly series (`insights.ts:979-998`) inspect period-end stock and last sale without counting stocked days. Worker historical trend likewise has no stock-day guard (`owner-report.ts:331-338`). A product restored to stock for one day after100 days without sales is protected today but counted dead at a historical end point at the same moment.

Historical versus live counts need not equal in general. This finding is the missing eligibility rule, not an assertion that different dates must match. Recommend applying the safeguard to historical as-of windows or naming the chart's simpler rule explicitly.

### S7 — Medium: plan rows combine current stock with saved runway/quantities

`apps/web/lib/data/plan.ts:623-632` returns live currentStock/current inbound, but stored daysUntilStockout/urgency/layer1 rate; qty stays stored unless override/what-if. `apps/web/lib/metrics/catalogue.ts:132-137` recomputes Stock rate and cover live. Example same fixed rate1/day: run held30, now shelf3 -> Stock3d, Plan onHand3 with saved30d. Owner email similarly uses current on-hand and saved runway (`owner-report.ts:544-545`).

This is a known architecture choice evidenced by comments in plan.ts:373-380, not proof that persistence itself is wrong. Clarify run-as-of labels and separate a saved plan from current risk. Freshness warnings reduce but do not remove mixed-time row arithmetic.

### S8 — Low/medium: negative stock subtracts capital in performance PDF

`apps/web/app/api/reports/pdf/route.ts:62` sums `currentStock*costKes` without clamping. Shared metric `apps/web/lib/metrics/calc.ts:119` uses `cost * Math.max(0,sellable)`; Stock money-at-rest and current dashboard capital use that rule. An oversold SKU -5 at cost100 reduces PDF capital by500 although it holds no capital. Explicit value definitions could differ, but the PDF says capital tied up. Same route uses a rolling time-of-day revenue cutoff (:42) rather than `trailingWindow` UTC day keys; for normal midnight daily rows these windows coincide except at exact UTC midnight, so this is a boundary risk, not a routine30-day disagreement.

### S9 — Medium: performance PDF labels all-class stockouts as A/B

Confirmed parent finding: `apps/web/lib/reports/report-pdf.tsx:108` labels `Stockouts (A/B at zero)`, but `apps/web/app/api/reports/pdf/route.ts:90` passes `today.stockedOutProducts`. `apps/web/lib/data/today.ts:86,105` counts every buyable class, with no ABC filter. One out-of-stock C and no A/B products prints1 A/B stockout. Correct the label or filter the data deliberately.

## Intentional differences and verified useful behavior

- Stock on-hand is sellable Sells rollup; warehouse units shown separately. Warehouse is not counted as sellable cover. Stock value includes sellable plus warehouse while money-at-rest uses shelf only (`stock.ts:83-91,316-317`). This must be labelled, not forced equal.
- Inventory branch cover is explicitly shop-wide, not branch-specific (`stock.ts:493-510`); exports say `Days cover (shop)` and `En route (shop)` (`apps/web/app/(shell)/inventory/inventory-export.tsx:42-43`). Summing repeated per-branch shop inbound in a spreadsheet would double count; labels are correct.
- ABC is read from saved Product.abcCategory across Stock/Plan/Insights/reports, not separately recalculated by each surface (`metrics/catalogue.ts:120-142`). Historical ABC trends use current classes and costs, so they are retrospective views, not immutable historical classification/valuation; label or snapshot if historical attribution matters.
- Original inventory-position view exposes chosen-window average sales per effective stock day (`../_ref-wezesha-restock/lib/inventory/position.ts:106-116`); current Stock uses weighted spike-damped engine demand. These deliberately measure different things; arithmetic parity requires a common mode/window, not merely porting the display.
- Current Stock facet `Not selling` means near-zero run rate and not-new (`apps/web/lib/facets/health.ts:71`); Today dead means no sale within configured window. Code calls this distinction intentional (`today.ts:37-40`). UX should continue to avoid calling both the same metric.
- Inventory export calls the same getter, rederives tenant/cost permission on server, returns all matching rows with the same sorting, and labels shared shop figures (`apps/web/app/(shell)/inventory/actions.ts:26-60`). No confirmed export cost leak found.
- Products catalogue export likewise rederives permission and applies `selectRows` to the complete catalogue (`apps/web/app/(shell)/products/actions.ts:79-100`). CSV, TSV and browser-print PDF share the same resolved rows/columns in `apps/web/lib/export/export-bar.tsx:66-67`; these exports use a deliberate reduced column projection, not every Stock/planner metric. Page-number slicing is not applied to export rows.
- `/stock` now redirects to Products, preserving catalogue query parameters (`apps/web/app/(shell)/stock/page.tsx:20-30`). `view=locations` redirects to Inventory at :19 but drops search/sort/page parameters; minor bookmark-filter loss, not a calculation discrepancy. Products and Inventory are actual separate pages, with shared stock getters behind them.
- Performance PDF obtains stockout/dead counts from Today and redacts costs at route (`apps/web/app/api/reports/pdf/route.ts:39,45,85-89`). Section PDFs render supplied already-redacted screen data. This audit did not run browser permission tests.
- Recent report segmentation calculates section budgets over complete section sets before truncating displayed rows (`owner-report.ts:558-571`), so omitted display rows do not silently reduce budget. Counts/full budgets and display limits are separate intentionally.
- `effectiveOnOrder = max(Shopify inbound, outstanding PO units)` is intentional duplicate-avoidance (`packages/db/src/inbound.ts:14-19,50`). It is an assumption, not reconciled shipment identity: independent unmatched inbound streams may be undercounted. No evidence that this happens in this tenant; treat as business/data-model risk rather than confirmed bug.

## Suggested repair/test order

1. Share planner assembly with worker; verify sent PO, received/cancelled PO, override0/20, MOQ12, slow mover, and an order placed after forecast.
2. Fix worker transfer input quantity and demand parity; test available2/onHand10 and null-location demand.
3. Define one current/historical dead-stock contract incorporating age and stock observation; test new, never-sold old, sparse snapshots, restocked yesterday, and monthly90d.
4. Define separately observed stockout exposure, bestseller stockout event rate, and missed-revenue estimate; test full-week outage and partial snapshot coverage.
5. Label plan as-of metrics clearly or recompute current risk consistently, preserving saved order rationale.

The daily watch report remains deferred.
