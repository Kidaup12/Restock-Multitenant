# Forecasting, ABC, inventory and reports: comparison audit

> Historical investigation snapshot. Implementation followed this audit: see
> [the port record](upstream-port-2026-10-05.md) for the POS rebuild, forecast
> controls, ABC settings, dead-stock rules and inventory report now implemented.
> Reproduction scripts here characterize the old behavior; they are not the
> acceptance tests for these changes.

Date: 5 October 2026. Reference: `Kidaup12/wezesha-restock` at `4eb1bc4`.
Target: this multitenant working tree, including the preceding upstream port.

## Conclusion

The two applications do not have equivalent forecasting behaviour, and neither
should be treated as a correct reference for every calculation. The most urgent
problems are corrupted/incomplete sales inputs, invalid backtest groups and
observation windows, and reports that bypass the planner's inventory rules.
Choosing mean versus median before repairing those inputs would optimize against
unreliable evidence.

The preceding port covered recent upstream commits, not every earlier divergence.
This audit found missing older safeguards, notably rebuilding POS daily totals
from the complete raw receipt ledger. It also found issues shared by both apps.

This was an investigation, not a repair pass. Production files were not changed
during this audit. The previous port remains in the working tree. No production
queries, live report sends, deployment, or database writes were performed.

## How evidence was obtained

Three agents independently inspected demand math, ABC/backtests, and UI/report
surfaces. A fourth track inspected ingestion/persistence and consolidated the
results. Deterministic fixtures use the same sales histories, dates, and stock
inputs. They execute actual pure functions; the POS writer is executed against
an in-memory database mock. Source tracing connects functions to production callers.

These tests establish code behaviour; they do not establish how many real shops
or SKUs are affected. PostgreSQL/RLS, real integration feeds, authenticated browser
flows and production data reconciliation remain unverified in this checkout.

Detailed evidence and executable cases:

- [Input/persistence findings](../scripts/audit-inputs/findings.md)
- [Demand and availability findings](../scripts/audit-demand/findings.md)
- [ABC and backtest findings](../scripts/audit-abc/FINDINGS.md)
- [Screen and report findings](../scripts/audit-surfaces/findings.md)

The harnesses deliberately assert **observed current behaviour**, including bugs.
A passing audit harness does not mean those bugs are fixed. Convert individual
cases into expected-correct regression tests as repairs are made.

## Highest-priority findings

P1 = likely to change purchase decisions, model selection, or an owner's assessment
of stock health. P2 = a material semantic/model-quality issue or conditional risk.

| Priority | Finding | Evidence / consequence |
| --- | --- | --- |
| P1 | Partial POS re-import overwrites a whole daily total | Raw receipts remain at 12 units, derived sales drop to 2. Original has a complete-raw-ledger rebuild missing here. |
| P1 | Corrected POS dates/channels leave old sales behind | Moving a 10-unit receipt to a new date leaves 20 derived units; physical-to-online correction leaves the physical copy. |
| P1 | Shopify updated-order deltas are used as full-day totals | A modified 1-unit order can replace an 11-unit corrected day. Empty refund/cancellation buckets cannot clear previous sales. Shared design problem, not solved by copying original. |
| P1 | Backtest omits revenue before revenue-based ABC | A true A SKU with 90 daily sales and 9,000 revenue becomes C; the query projection causes every backtest SKU's revenue to be zero. |
| P1 | Backtests skip fully silent holdouts | A forecast of 25.479 units against zero actual sales is omitted unless an explicit zero record is inserted at the horizon end. |
| P1 | Backtests do not replay live availability inputs | Same history with 20 known stockout days: live baseline 1.681/day, audition 0.877/day. Champions are selected using a different information set. |
| P1 | Owner email does not use the planner's full inventory contract | An outstanding 40-unit PO appears as zero inbound if Product.onOrder is zero; overrides, sizing/exclusion rules and committed stock can also diverge. |
| P1 | Weekly email excludes products that sold nothing while fully stocked out | One A SKU observed at zero all seven days reports 0% stockouts and zero missed revenue because the calculation requires a sale in that week. Shared original rule; operationally misleading. |
| P1 | Warehouse transfer email can suggest committed units | Ten physically present, eight committed: email sizing uses ten; UI's available-stock sizing uses two. |
| P2 | Availability coverage is assumed at tenant level | A SKU with no own snapshots can be treated as covered since another SKU's first snapshot. Controlled impact: rate 1 becomes 0.7945/day. Actual incidence needs data. |
| P2 | Fixed windows create a shared 60-day demand cliff | Stable 1/day seller: rate 1 at 59 days of history, 0.7329 at day 60. Both apps have this transition. |
| P2 | The new ABC stability check is span, not sustained sales | Only two 40-unit sale dates, 79 days apart, qualify A. The recently ported rule does not establish two weeks of sustained recovery. |
| P2 | New never-sold products can be labelled dead | A one-day-old stocked SKU with no snapshots is dead here, protected by age checks in the original. |
| P2 | Historical and current dead-stock definitions disagree | With a 90-day window and last sale Aug 31, September email calls the item dead while October 5 Today calls it healthy. This monthly rule also exists in original. |
| P2 | Report labels do not always match their population | PDF labels stockouts as A/B while receiving Today's all-buyable-class stockout count. |

## Silent days and no-stock days

The central missing contract is a product-day observation state. A missing sale
record by itself cannot establish either zero demand or an empty shelf.

| Day state | Recommended treatment |
| --- | --- |
| Complete sales feed, known available stock, no sales | Real zero demand observation; retain the day in exposure and accuracy scoring. |
| Known unavailable stock | Censored demand; zero sales does not prove zero demand. Record exposure and evaluate the model accordingly. |
| Missing feed or inventory observation | Unknown. Preserve uncertainty; do not silently certify the day as in stock or unavailable. |
| Known store closure | Explicit non-trading day, with a consistent exclusion policy. |
| Promotion / bulk transaction | Mark explicitly; apply the same baseline and backtest policy, without making the day look like a missing feed. |

Current inferred-gap logic uses long interior gaps only and depends on the rows
present. Adding zero-valued rows to the same positive-sale history changes the
rate from 1 to 0.7945/day. A trailing silent period has no closing sale and does
not qualify as an inferred gap. These are rules to make explicit, not evidence
that every silent period should be removed.

Snapshot zero is an instantaneous observation, but the denominator treats it as
an entire unavailable day while retaining that day's sales. A contradictory-input
stress case (one sale daily, every snapshot zero) yields 16.4286/day instead of an
observed one/day in both baseline implementations. This is a robustness test,
not a claim that such a year occurred; downstream safeguards may cap final demand.

The `recent_heavy` challenger also handles inferred gaps differently from
`run_rate`. A no-snapshot ten-day gap gives 0.6667 versus 1/day. With explicit
in-stock evidence, 0.6667 is correctly 20/30 for a recent-only method; differing
window weights are intentional. The problem is changing availability assumptions
at the same time as the weighting method without accounting for it in evaluation.

## Mean, median and model selection

There are several different uses of a median here; they are not interchangeable:

1. Arithmetic/recency-weighted mean estimates units over exposure days.
2. Current median sale-day statistics cap isolated spikes before computing demand.
3. Original selectable median forecasting takes a median of weekly rates.
4. Accuracy losses have different targets; an intermittent series can have zero
   median while retaining positive expected demand.

Current runtime exposes `run_rate` and `recent_heavy`, not the original's selectable
mean/weekly-median and Python-sidecar path. The external audit engine connection
does not supply that missing runtime: several winning model IDs, including median,
ETS and Theta, are mapped to one of the two TypeScript methods. Picking the best
single ABC×XYZ segment to represent an entire ABC class is not an all-class validation.

Executed baseline comparisons:

| Identical input | Current / original mean | Original weekly median | Interpretation |
| --- | --- | --- | --- |
| Established steady one/day | 1/day | 1/day | Agreement on the simple control. |
| Steady one/day plus a 100-unit day | Current 1.0205; original default mean 3.0342 | 1/day | Preserve current spike damping; original optional debulking is a separate path. |
| One unit every 21 days | Original mean 0.05986/day | 0 | Median is not a safe default for intermittent replenishment. |
| 165 selling days followed by 200 confirmed stockout days | Original censored mean 0.2/day | 0 | Empty calendar weeks remain in the median; multiplying zero by an availability uplift cannot recover demand. |

Original weekly buckets also use `(start, end]`, while current production demand
generally uses `[start, end)`. Normalize boundaries before treating numerical
differences as model quality. Do not copy the original median implementation wholesale.

Backtest repairs also need origin-specific ABC, training-only error scales,
minimum training/observation eligibility, and the same buyable product universe.
Fixing the omitted revenue alone would expose the existing use of today's class
for past origins; it would not make the historical comparison valid.

## Screen and report reconciliation map

| Surface | Present basis / issue to reconcile |
| --- | --- |
| Products / legacy Stock | Live shared catalogue demand and sellable stock; ABC is read from the saved product class. Preserve one ABC producer. |
| Inventory | Per-location units; explicitly labelled shop-level cover. Do not sum repeated shop-level metrics across branch rows. |
| Planner / budget | Combines saved prediction fields with some live stock and inbound data; stale runway/quantities can coexist with refreshed stock. |
| Today / dashboard | Shared current stock and dead-stock counts; uses the newly added observation-day floor, but still lacks original new-product age protection. |
| Insights current views | Shares some Today metrics and current observation rules; historical computations have distinct windows and populations. |
| Weekly/monthly email | Independent queries and historical metric implementation; uses final forecast rate, raw inbound, and a narrower subset of planner rules. |
| PDF | Reuses Today counts but has an A/B stockout label on an all-class count. |
| CSV / section exports | Mostly reuse screen rows, preserving their definitions and differences; complete row-level live reconciliation still requires a database/browser fixture. |

Every metric should carry its population, date/window, rate basis and stock basis.
“Current shelf stockout”, “forecasted stockout”, “period with any stockout” and
“percentage of observed product-days unavailable” need separate names and denominators.
Historical figures can intentionally differ from today's figures; unexplained
changes in definition must not be presented as comparable trends.

## Improvements in this app to retain

- Correct ABC cumulative boundary: a 95%-of-revenue dominant earner is A here,
  but C in the original boundary implementation.
- Class-C ordering covers long lead time instead of always targeting only 14 days.
- Daily aggregation before spike statistics avoids counting two channels as two sale days.
- Production demand excludes future rows and supports explicit promo/closure masks.
- Better short-history handling before the 60-day transition.
- Available stock rather than committed-inclusive physical stock in the main UI.
- Variant matching, tenant-local sales dates, processed sale dates and refund netting.
- Tenant isolation, permissions and currency handling; never replace these with
  original single-workspace assumptions.

## Repair sequence and acceptance criteria

1. **Repair input conservation first.** Preserve complete product/day totals under
   partial replays, corrected dates/SKUs/channels, cancellations and full refunds.
   Use atomic writes; retain previous affected keys. Add a tenant-scoped dry-run
   raw-ledger reconciliation before any historical rebuild. Do not run a repair
   against production based solely on these synthetic cases.
2. **Define one daily observation/exposure contract.** Per-product coverage and
   trading day; unknown versus observed zero; stockout versus closure; positive
   sales on zero snapshots. Missing snapshots must not count as proof of availability.
3. **Repair ABC and auditions.** Restore revenue, replay point-in-time inputs,
   include covered silent outcomes, remove leakage, enforce training eligibility,
   align lifecycle scopes. Recompute scores/champions only after those tests pass.
4. **Unify decision/report inputs.** Reuse effective inbound, available units,
   overrides, sizing and buy-list exclusions in email and exports. Agree whether
   a field is live or from a dated forecast; never mix them without disclosure.
5. **Evaluate mean versus median fairly.** Same observations, exposure, origins,
   exclusions and business cost metrics; evaluate intermittent and long-lead SKUs
   separately. Add a median method only if its out-of-sample results justify it.
6. **Reconcile real fixtures end to end.** Choose steady, intermittent, new,
   recently restocked, long-lead, all-week-stocked-out and committed-stock SKUs.
   For each, reconcile raw inputs → daily history → ABC → forecast → quantities →
   Stock/Inventory/Plan/Today/Insights → email/PDF/CSV, with exact expected outputs.

The deferred daily imports-watch report remains outside this repair scope.

## Reproduction commands

From the repository root, using the dependencies already installed:

```powershell
.\node_modules\.bin\vitest.cmd run --config scripts/audit-inputs/vitest.config.ts
node scripts/audit-demand/run.cjs
node scripts/audit-abc/run.cjs
node scripts/audit-surfaces/evidence.mjs
```

No environment secrets, network calls, or running database are needed for these
audit fixtures. Details of the scripts' mocks and pure-function extraction are
in the corresponding evidence files.
