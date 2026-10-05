# Original-app changes ported on 5 October 2026

Source: `Kidaup12/wezesha-restock`, `3e369c6..4eb1bc4` (main).

The subsequent comparison also ports features from the original's broader codebase,
not only that commit range. This is an implementation record; the separate audit
and its characterization scripts describe the pre-port state, not acceptance tests
for the repaired behavior.

## Forecast controls and sales input port

- Settings → Ordering strategy now offers mean/median demand and 30/60/90-day ABC
  revenue windows. Changes are permission checked, tenant scoped, validated and
  audited. Stock metrics read the selected method immediately; persisted ABC and
  Plan predictions change on the next forecast run.
- Median uses the original's weighted weekly windows (56/182/364 days), adapted
  for availability and sparse demand. Confirmed full-stockout weeks are omitted;
  silent available days contribute zero. Sparse or zero-median positive-demand
  histories fall back to an exposure-adjusted mean. New-product handling remains.
  Mean retains the current app's existing gap inference and spike damping.
- ABC's chosen revenue window and stability span reach both live runs and the
  backtest runner. Backtest input now includes recorded revenue, fixing the
  missing-revenue all-C classification. Median selection also reaches catalogue
  rates, override reruns and borrowed-product estimates.
- POS ingestion atomically replaces receipts and rebuilds every affected day from
  the complete stored receipt ledger, including old dates of corrected receipts.
  Tenant locks serialize ingestion and repair. The worker repairs the trailing
  35 days even after an empty pull. Tenant, branch, online-sale exclusion, learned
  SKU aliases and ignore rules are retained.

Before deployment, apply `20261005170000_baseline_method` using the normal database
migration process, then deploy web and worker together. The migration is included
but has not been applied to a live database.

This port does not claim that every difference found in the audit is resolved:
the existing mean silent-gap heuristic, backtest silent-holdout treatment and
historical classification methodology remain follow-up work. The imports-watch
report remains explicitly deferred. Owner-selected median overrides automatic
champion selection; its backtest rows are not a mean-versus-median audition.

Port verification: the forecast suite passed 411 tests, with three additional
forecast-control regressions passing afterward. POS unit tests passed 32 cases;
forecast-run passed 34 cases (37 database cases skipped). Focused web settings,
planner, inventory and dashboard checks passed 29 cases (six database cases
skipped), with the additional median metric propagation test also passing.
Owner-report regressions passed seven cases. Web, worker, forecast and
forecast-run typechecks and scoped lint passed. POS transaction/concurrency tests
were added for a real database but could not run without PostgreSQL.
The final production Next.js build passed, including the new inventory-position
route and forecast settings. Build database URLs were inert placeholders;
authenticated browser and live database verification remain outstanding.

## Bulk-control follow-up

The original's separate `big-buyer.ts` rule is now shared engine code. It detects
daily totals strictly greater than `max(6, 5 * medianPositiveDay)` and caps the
demand-only copy at `max(5, round(3 * medianPositiveDay))`. Channel rows are grouped
before classification and capped proportionally; stored sales, revenue and
backtest actuals are unchanged. Known promo/closure dates and incomplete/future
days do not influence the baseline cleaner.

Settings → Ordering strategy includes the original's optional bulk-day damping
switch (default off). It applies to forecasting and live Stock rates, including
variability/safety stock, serving floors, caps and the reality guardrail. A
regression exposed the initial raw-history safety-stock bypass and verifies the
entire pipeline against explicitly cleaned evidence. Detection and visible flags
remain active whether the switch is enabled or disabled.

This follow-up adds migration `20261005180000_big_buyer_damping`. Apply both
included settings migrations through the normal deployment process before
deploying these code changes. No live migrations or report sends were performed.

Bulk engine validation: 428 forecast tests passed, forecast typecheck passed,
and 15 focused settings/live-metric tests passed. Forecast-run passed 34 tests;
37 database tests skipped without PostgreSQL. The earlier production-build
result above predates this follow-up; final verification is recorded below.

## Report parity and final review

See [the report coverage map](upstream-report-parity-2026-10-05.md) for the active
original report-to-target mapping. This follow-up replaces the History placeholder,
adds real custom date ranges, weekly placed-order and above-recommendation totals,
historical dead/excess-stock SKU drilldowns and matching exports. Owner emails now
use planner overrides, minimum quantities, purchase commitments and received-net
inbound. The shop PDF's stockout scope label and negative-stock capital handling
also match their underlying metrics.

Bulk flags and live rate fitting use the shop's timezone. Incomplete current-day
sales can appear as review evidence but cannot inflate forecast variability,
safety stock or guardrails; future rows cannot leak into fitting. Forecast tests
now pass 430 cases, including full-pipeline regressions for both toggle states.
Worker tests passed 32 cases (134 integration cases skipped without services),
and worker/forecast/forecast-run typechecks passed. The combined production Next.js
build passed after the report additions. Local PostgreSQL/Redis and authenticated
browser verification remain unavailable; no production changes or email sends
were made.

The new weekly report is registered in the application's cost-surface manifest.
Loader-level tests verify all summary and drilldown cost values are absent for
members without cost access; registration did not relax the scanner.

| Upstream change | Multitenant treatment |
| --- | --- |
| Class-A sales stability | Shared forecast engine requires positive sales spanning at least 14 days; live forecasts and backtests both supply the span. |
| Dead-stock shelf-presence floor | Today tiles/table and current Insights breakdowns require 14 observed in-stock days when snapshots exist. Missing snapshot coverage retains the previous rule. Historical trend calculations are unchanged. |
| Partial AI-run protection | Shared run selector rejects AI preference below half the largest same-day run; used by the buy list and owner reports. Normal multitenant forecasting already replaces the current predictions atomically. |
| Owner report sections | Out of stock, critical fast movers, upcoming fast movers, and slow/medium movers; full bucket counts and budgets before display caps; rate/on-hand/en-route columns; Class-A health and completed-period top sellers. Tenant currency and tenant-scoped queries retained. |
| Report subject branding | Subjects include the configurable report brand. |
| Report recipient exclusions | Optional `REPORT_EXCLUDE_EMAILS` comma-separated addresses, case-insensitive, layered over existing membership/notification preferences for weekly/monthly reports only. |
| Pending-order cleanup | Not copied: this application's pending orders are user-created. The original's machine-generated pending queue does not exist here. |
| Imports-watch reports and scripts | Deferred at the user's request. The original's Korean/Western tags do not map directly to this app's custom categories. |

The budget crash was independent of the upstream update: server actions imported
`filterBuyListRows` and `LEAD_BANDS` from a `"use client"` component. Shared scope
logic now lives in `app/(shell)/plan/scope.ts`, used directly by budget and saved-scope
actions. A regression test makes importing the client component fail while exercising
filtered and unfiltered budget requests.

No deployment, production database changes, or report sends were performed.

Validation from the earlier port pass (before the follow-up changes below): production Next.js build passed; web, worker, forecast and forecast-run
type checks passed; changed-file lint passed. The existing 394-test forecast suite,
three new forecasting stability tests, and focused planner/report regressions passed.
Six dashboard database integration cases were skipped because no local database is
configured. Build-time database URLs were inert placeholders; authenticated browser
and live database verification remain outstanding.

## Follow-up: original inventory-position report and new-product eligibility

The Inventory page now links to `/inventory/position`, a shop-wide report using
the original's chosen-window inventory calculation. Readers can select 30, 60,
or 90 days, search by product/SKU/supplier, and compare opening stock, sold units,
current sellable stock, inbound stock, sales per day and cover. ABC classes remain
the forecast run's saved classes; unclassified products remain explicitly unrated.

The rate is actual net units sold divided by window days minus confirmed
empty-shelf days, using the original's adaptive 3–7-day denominator floor. It is
labelled as a window average, separate from weighted forecast demand. Observed
in-stock/out days and total snapshot coverage are displayed: missing snapshot days
are not presented as observed in stock. The current calendar day is included.

Opening stock uses a snapshot on the window's first day. When unavailable,
the original's `current + sold` estimate is clearly marked as excluding receipts
and transfers; this is not an inventory reconciliation. Current stock is the
Sells-only sellable rollup, and inbound uses the existing maximum of Shopify inbound
and outstanding sent/partially-received purchase orders. Warehouse stock remains
separate on the main Inventory page. No cost fields are selected by this report.

The screen pages at 100 rows; CSV, copy and printable PDF exports include every
matching row, use the same calculations, and include opening-estimate and rate
denominator evidence. Export actions resolve the member's own workspace server-side.

Current dead-stock classification now also includes the original's new-product
protection. Never-sold products must be at least 60 days old; unknown ages remain
unclassified as dead. Age uses Shopify's creation date, falling back to received
date. The existing 14 observed in-stock-day safeguard remains. Today tiles/table
and current Insights overview/category/ABC breakdowns use one pure eligibility
function; the performance PDF inherits Today's counts. Zero-quantity and return
rows no longer reset the last-positive-sale date. Historical dead-stock trend
definitions have not changed in this follow-up.

Follow-up validation: 16 focused tests passed across inventory-position arithmetic
and exports, new-product eligibility, and dashboard classification. Fourteen local
database cases were skipped because no local database is configured. Full web
TypeScript checking and scoped ESLint passed. Authenticated browser and database reconciliation
remain outstanding; no deployment or production database changes were performed.

## Follow-up: visible bulk-purchase and unusual-sales review

The original's separate bulk-day rule now feeds visible review cards on Today,
Sales data, product detail and Settings → Signals. Detection is independent of
whether the optional bulk-purchase protection setting is enabled. A possible bulk
day has total units strictly greater than `max(6, 5 × median positive sales day)`.
This catches a seven-unit day for a typical one-unit seller, which the existing
generic eight-unit-minimum spike prompt missed. The generic three-times detector
is retained for other unusual days.

Both detectors now receive totals aggregated across every channel/branch for
each product/day. Bulk evidence covers the last year; generic prompts retain the
recent 14-day window. Product-specific promotions no longer hide other products'
flags. Promotions are matched by the existing SKU/brand/category scope rules.

Cards show the date, actual daily quantity, typical selling-day quantity and
multiple, with explicit "Possible bulk purchase" wording. Daily totals do not
prove one customer placed a bulk order. Large accumulating current-day totals
can be flagged immediately and are labelled "today so far"; forecast fitting
separately excludes incomplete current days. The newest flags appear first;
visible limits are five on Today/Signals, 100 on Sales, and 20 on product detail.

Owners or members with settings permission can record a genuine promotion or
dismiss a reviewed flag. Dismissal is persisted per tenant/product/day and only
clears the prompt: it does not edit sales or adjust the forecast. The card links
to forecast settings for bulk-purchase protection. All members can see evidence;
management controls remain permission-gated on the server. Actions refresh every
affected surface, and failed saves display an error while retaining the flag.

Bulk-review validation: 11 focused detector, rendered-UI and action tests passed;
three local-database spike tests were skipped without a configured local database.
The regression cases cover the previously missed seven-unit day, cross-channel
aggregation, unrelated SKU promotions, future rows, management permissions,
tenant-scoped dismissals, promotion recording and read-only visibility. Full web
TypeScript checking and scoped ESLint passed for this follow-up.

The sales-review query and "today so far" label now resolve the tenant's timezone
to a trading-day marker before comparing SalesHistory dates. This includes
Nairobi sales just after local midnight even before UTC midnight, and avoids
including tomorrow's marker for shops west of UTC. Raw timestamps are unchanged.
Thirteen focused review tests passed after this correction, including both
timezone boundaries.

### Final combined verification

- Production web build passed. Forecast, forecast-run, worker and web TypeScript checks passed.
- Forecast: 430 tests passed. Forecast-run: 34 passed, 37 service-dependent tests skipped. Worker: 32 passed, 134 service-dependent tests skipped.
- The final broad web run recorded 991 passed, 666 skipped and two failures caused by stale fixed-30-day text assertions. Those assertions were updated for the selected report period, and a remaining empty-state label was corrected. The affected suites then passed: 21 tests passed, 26 service-dependent tests skipped; scoped lint passed. The broad suite was not repeated after this correction.
- Registered Inventory position in the HTTP smoke-route inventory and registered the new period-inventory getter in the cost-visibility manifest. Focused coverage and cost-redaction tests passed. Live HTTP smoke checks were not run.
- Database-dependent and authenticated-browser verification remain unperformed without configured services. No deployment, live migration or report delivery was performed.
