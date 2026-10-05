# Original report coverage and multitenant implementation

Reference: `_ref-wezesha-restock` at the revision pulled for this port. This is a feature mapping, not a claim that every historical calculation is identical. The active original Reports page mounts **Overview, Performance, History**. `inventory-tab.tsx`, `insights-tab.tsx`, standalone `service-level.tsx`, `adherence.tsx` and `track-record.tsx` also exist in the original tree; file existence alone does not establish that the active Reports page renders them.

## Active features

| Original | Multitenant location | Coverage |
| --- | --- | --- |
| Reports Overview: revenue, capital tied up, revenue at risk, ABC mix | `apps/web/app/(shell)/insights/overview-kpis-section.tsx` | Existing implementation, tenant currency/permissions retained. |
| Top sellers, class lens, table exports | `insights/top-earners.tsx`, `top-earners-view.tsx` | Existing implementation. |
| Dead stock window, list, export | `insights/dead-stock-section.tsx`, `dead-stock-export.tsx`, `lib/data/insights.ts` | Existing implementation; this port also improves evidence for never-sold products elsewhere. |
| Overstock/excess list and export | `insights/overstock-section.tsx`, `overstock-export.tsx` | Existing implementation. |
| Incoming order list and export | `insights/on-order-section.tsx`, `on-order-export.tsx` | Existing implementation. |
| Category and brand revenue | `insights/revenue-breakdown.tsx` | Existing implementation. |
| Forecast engine/settings card | Settings plus forecast scorecard/onboarding audit controls | Adapted; original selectable Python sidecar is not the multitenant runtime. Mean/median and bulk handling are covered by the coordinated forecasting port. |
| Before/after impact | `insights/impact-card.tsx`, `before-after.tsx` | Existing implementation with its own measurement scope. |
| Stockout, dead stock, missed-revenue trends | `insights/stockout-trend.tsx`, `dead-stock-months.tsx`, `missed-revenue.tsx` | Existing implementation; absent observations remain explicitly unmeasured. |
| Category/brand loss matrix and exports | `insights/leakage-matrix.tsx`, `leakage-matrix-view.tsx` | Existing implementation. |
| Weekly period table with SKU drilldown | `insights/period-table.tsx`, `period-table-view.tsx`, `purchasing-history.tsx` | Existing stockout/sales table plus **new** placed-order, above-saved-recommendation, historical dead/overstock table and SKU drills. Full total/detail exports included. |
| Accuracy and recommendation adherence | `insights/forecast-scorecard.tsx`, `lib/data/insights.ts` | Existing target implementation, with corrected forecasting/backtest inputs in the coordinated port. |
| Custom Performance date span | Report range resolver, insights loaders, controls and panels | Implemented by the coordinated date-range port, using both start and exclusive end bounds with separate day-marker and tenant-instant representations. Final combined verification recorded in the main port note. |
| Searchable SKU History | `insights/history-tab.tsx`, `history-export.tsx`, `lib/data/product-timeline.ts` | **Implemented now**, replacing the literal “coming soon” placeholder. Search title/SKU, select product, see retained recommendations, queued orders, PO creation/sending, cumulative receiving, daily channel sales, and empty-shelf observations. CSV/clipboard export uses the same event rows. |
| Shop PDF and section PDFs | `apps/web/app/api/reports/pdf/route.ts`, `section-pdf/route.ts`, `lib/reports/*` | Existing implementation. |
| Weekly/monthly owner report email | `apps/worker/src/crons.ts`, `owner-report.ts`, `owner-report-email.ts` | Existing scheduled implementation plus the actionable-quantity corrections below. |

## Owner report fixes in this pass

The original owner report and the earlier target port both read raw persisted recommendation quantities. The target planner has additional business rules that the email bypassed. The report now:

- Queries only lifecycle-buyable products using `BUYABLE_PRODUCT_WHERE`.
- Applies `ProductPlanOverride` before selecting buy rows, including zero overrides and positive overrides on engine-zero products.
- Applies the **same** supplier minimum function used by Plan and PO creation. `applyMoq` now lives in `packages/forecast/src/order-quantity.ts`; `apps/web/lib/po/po-math.ts` re-exports it so existing consumers retain their interface.
- Excludes pending purchase commitments and orders on sent/outstanding POs, while unsent draft POs remain actionable as in the planner.
- Applies the planner's low-urgency, below-one-unit/day slow-mover holdback unless an owner override exists.
- Uses `outstandingByProduct` and `effectiveOnOrder` to display incoming stock after partial receipts without double-counting Shopify incoming units.
- Computes section counts and full budgets **after** these adjustments and **before** display limits. Inventory attention still examines all buyable forecast rows, even when a purchase is excluded.

Regression example: an owner suppresses an out-of-stock line, asks for two units of a line whose supplier minimum is twelve, and already committed another line. The email reports twelve units/cost120 for the minimum line, excludes the two suppressed/committed buys, displays eighteen incoming units for a PO of twenty with two received, and reconciles full total420/count11 across the remaining buckets.

This does not rescale the persisted forecast every time stock changes; the default planner also reads the last run's recommendation. A stale run still requires refresh. Inventory urgency/demand remain the saved run's values unless a separate existing live metric explicitly says otherwise.

## History limits and data provenance

- Every read uses a tenant-scoped RLS transaction. Product lookup occurs before reading events; unavailable/foreign IDs return no timeline. No cost or PO monetary fields are selected.
- The display covers the last year, bounded to 1,000 event rows, with a visible truncation warning. It does not invent missing historical recommendations; only retained `ForecastRecommendation` records appear.
- Receiving storage carries cumulative line receipts and their latest timestamp. The UI explicitly labels these as cumulative, rather than fabricating individual delivery quantities/dates.
- Daily sales retain their channel. Dates follow stored dates (UTC for timestamped actions); the UI states this. History is independent of the financial-report date lens.
- No audit-log edit events or deleted PO records are currently exposed. Original `edited` event capability is therefore not claimed as complete parity.

## Weekly purchasing and historical inventory implemented

Original formulas were verified in `lib/metrics/stock-health.ts` and `app/api/metrics/route.ts` before porting. Target `PurchaseOrderLine` already retains `recommendedQty`, so no schema expansion was needed.

- Placed PO quantities and their stored line totals are bucketed by tenant-local `sentAt`, falling back to `createdAt` only when no sent timestamp exists. Draft, cancelled and deleted orders are excluded. Both custom-range bounds apply; a PO created earlier but sent within the selected range is included.
- Above-saved-recommendation units equal `max(0, quantity - recommendedQty)` for lines with a saved recommendation, valued at saved PO unit cost. Manual lines with no recommendation remain unmeasured and display their count. No measured comparisons yields a dash, not a false zero. The wording explicitly allows supplier minimums and owner decisions.
- Dead/overstock use actual snapshots on the **final selected day** of each week. Missing endpoint observations are not reconstructed. Snapshot-day counts and endpoint-observed product counts accompany the metrics and exports.
- Dead stock requires prior positive sales and no positive sales in the configured trailing day window. The loader reads first-sale evidence beyond the displayed range; it does not lose a previously selling product just because the quiet window has no sales.
- Overstock uses the shared `overstockExcess` function, period sales divided by the selected period's day count, and a 90-day cover threshold. Clipped/custom weeks use their actual selected day count. Zero sales are not turned into infinite overstock.
- Historical stock quantities are valued at **current catalogue costs**, matching the available original inputs; PO quantities use saved PO costs. This basis is stated beside the table and in the printable export.
- Summaries and SKU details are cost-redacted before they become export props. Visible drill lists cap at 100 detail lines per week with an explicit message; exports retain the complete calculated details.

## Remaining differences, explicitly not completed by these changes

1. **Dashboard pinned report shortcuts:** original dashboard `pinned-reports.tsx` reads per-user local pins. No equivalent pin store/strip was found in the active target Today screen. This is a navigation feature, not a calculation fix.
2. **Original Python runtime model suite:** the target audit-engine model-to-two-method mapping remains distinct from executing the original sidecar models. No sidecar parity is claimed by report controls.
3. **Daily imports-watch:** intentionally deferred by the user; it is not included in this port.
4. **Dormant original components:** standalone inventory-intelligence and opportunity-card tab implementations are not mounted by the original active Reports page. Similar facts exist in target Stock/Today/Reports; no separate hidden tab was copied just because its file exists.

## Verification

- Owner report suite: six tests passed, covering full-bucket counts, budget sums, permission-neutral currency rendering, planner holdbacks, overrides, MOQ, and received-net incoming units.
- Product History suite: five mocked-transaction tests cover tenant lookup gating, retained recommendation provenance, old-created/recently-sent PO inclusion, cumulative receipts, bounded event export, scoped search, and current local-day sale/snapshot markers before UTC midnight.
- Weekly inventory/purchasing suite: six deterministic tests cover saved recommendation comparison, manual-line unknowns, historical end-stock, dead/overstock formula, missing observation honesty, date bounds/clipped periods, and complete cost redaction.
- Worker and web typechecks passed after these changes; changed report/history files passed lint. The combined production build passed. Final test results and verification limits are recorded in [the implementation record](upstream-port-2026-10-05.md#final-combined-verification).
- No live PostgreSQL/Redis report delivery or authenticated browser timeline was exercised in these isolated tests. No email was sent.
