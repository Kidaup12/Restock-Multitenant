# Demand mathematics audit — 2026-10-05

Scope: current `Restock-Multitenant` versus sibling `_ref-wezesha-restock`, fixed as-of day 2026-10-05. No production code changed. Findings are source inspection plus deterministic calls to the actual pure calculation functions, not live-store measurements. Numerical results below are baseline demand rates before downstream guardrails, overrides, and order policies unless stated otherwise.

Reproduce from the current repository root:

```powershell
node scripts/audit-demand/run.cjs
```

The loader transpiles local TypeScript with the installed TypeScript package. It avoids a sandbox-specific `tsx` failure (`uv_os_get_passwd ENOMEM`). Assertions reproduce existing behavior; passing them does not certify that the behavior is desirable. Both repository directories and current node_modules must exist.

## Confirmed defects or contract inconsistencies

### D1 — Shared 60-day discontinuity (high)

A product selling precisely one unit daily gets 1/day with 59 days of history and 0.732876712/day with 60 days. The 26.7% decline comes solely from switching from a short-history denominator to fixed 30/90/365 windows, including days preceding the available history.

Current: `packages/forecast/src/layered.ts:258-272`; original: `lib/forecast/simulate-layers.ts:135-152`. This is a shared defect, not an upstream fix waiting to be copied. Current improves the under-30-day case by using the observed span (minimum seven days), while original uses a flat 30-day denominator. Normalize longer windows to eligible exposure/history or transition smoothly; test 59/60/61 days with unchanged demand.

### D2 — Original median can erase intermittent or censored demand (high; upstream-copy blocker)

Original `lib/forecast/baseline.ts:220-245` takes a median over weekly calendar buckets that include unavailable weeks, then applies a stockout uplift after the median. Multiplication cannot recover a median of zero.

- One unit daily on days 201–365 before as-of, followed by 200 proven stockout days: original censored mean 0.2/day, original censored median 0.
- One unit every 21 days across 358 days: original mean 0.059863014/day, median 0.
- One unit every 14 days across 351 days: mean 0.087579909/day, median 0.071428571/day.

Weekly median zero for sparse demand is a mathematical property, but treating that number as expected unit demand/absence of demand is an unsafe forecast policy. Require availability-aware buckets and an intermittent-demand fallback before enabling this as a forecasting option. Current has no weekly-median option: `packages/forecast/src/layered.ts:219` permits only `run_rate` and `recent_heavy`.

Original's cap at twice the median immediately before taking the same median (`baseline.ts:235-241`) does not change the median for nonnegative data. The claimed extra defense against runs of spikes is not provided by this step.

### D3 — Original median bucket date boundary differs from current (medium)

Original `lib/forecast/baseline.ts:154-169` uses age >= 0 and age < window: this includes the as-of day's partial sales and excludes the oldest boundary day. For one seven-day bucket, a seven-unit sale exactly at as-of returns [7], while a sale exactly seven days earlier returns [0]. Current `packages/forecast/src/baseline.ts:90` uses the intended completed-day interval [since, asOf). Align boundaries before porting median.

### D4 — Tenant-global snapshot start stands in for product-day coverage (high/medium)

Current `packages/forecast-run/src/run.ts:356-359` reads the earliest snapshot across the tenant, and `:401` passes that date for all products. `packages/forecast/src/baseline.ts:229-231,250-265` treats history following the coverage start as no longer needing inference. Missing rows after that start cannot be distinguished from positive-stock observations using the loaded empty-only mask.

Controlled established 1/day product with ten internal silent days: no snapshot coverage gives inferred 1/day; coverage dating back a year plus empty stockout mask gives 0.794520548/day. The latter is correct if this product actually had stock, but unsupported if it lacks its own snapshots. Source confirms the information loss; live incidence is not established by this audit. Products introduced/reactivated later and missed snapshot runs are cases to investigate.

Partial coverage starting midway through a silent gap also gives 0.794520548: inference is restricted to the older slice and loses the sale on the far side needed to bracket that gap (`baseline.ts:222-231`). This is a confirmed limitation of the promised pre-coverage fallback; whether/how to infer the unseen slice remains a policy decision.

Recommendation: track per-product observed days and availability, explicitly representing unknown days. Do not label tenant-wide elapsed calendar time as proven exposure.

### D5 — Current challenger does not preserve gap-inference semantics (medium)

Current `packages/forecast/src/layered.ts:226-247` says both methods share censoring and differ only in recency weighting. But `recent_heavy` calls `rateOverWindow` (`:185-199`) without snapshotsSince and never infers gaps; established run_rate can infer them.

Same 365-day established seller with ten internal silent days:

| Evidence | run_rate | recent_heavy | Interpretation |
|---|---:|---:|---|
| No snapshots | 1 | 0.666666667 | Different inference assumptions as well as weighting |
| Explicit proven no-stock days | 1 | 1 | Both correct the denominator |
| Explicit full-stock coverage, no stockouts | 0.794520548 | 0.666666667 | Expected recency-window difference; 20/30 is correct recent mean |

Do not describe the no-mask difference as proof of stockout or as simple underprediction. The bug is the claimed shared contract and confounded model audition. Choose and document one availability policy for competing methods.

### D6 — Future rows inflate original mean and current raw helper (medium)

With 365 days at one unit/day plus a 1,000-unit sale dated tomorrow, current production runRateDaily remains 1/day. Original adjusted mean becomes 21.547945205/day because its numerator has no as-of upper bound (`lib/forecast/baseline.ts:55,93`). Current raw weightedDailyRate still has the same issue (`packages/forecast/src/baseline.ts:32`), although its production damped path excludes future rows (`:90`). Trace raw-helper callers before alleging a live forecast effect. Preserve the current production date filter.

## Evidence interpretation and business-rule choices

### P1 — A silent day is not automatically a stockout

Both gap heuristics require at least two records, average raw window volume >=0.5/day, and an internal gap of at least seven missing days. They do not infer trailing silence or initial silence. The inference knowingly assumes stockout in sufficiently active products; it is not proof of stock availability. Proven in-stock zeros should remain in the exposure denominator, and unknown/missing feeds should carry uncertainty. Current `packages/forecast/src/baseline.ts:142-169`; original `lib/forecast/baseline.ts:25-39`.

Current executed representation check: ten absent rows yields 1/day, while the same positive sales with ten explicit zero-quantity rows yields 0.794520548/day. All rows act as gap endpoints, including zero quantities. This is defensible only if explicit zero rows certify a complete observation with known availability; SalesHistory alone does not express that. Standardize inputs and day-state semantics before changing the heuristic.

### P2 — Opening snapshot is not full-day availability (interpretation risk)

Current worker schedules an opening/nighttime snapshot (`apps/worker/src/snapshot-cron.ts:22`) and records instantaneous currentStock keyed to a UTC day (`:109,123`). This cannot prove that the product stayed unavailable throughout that date: replenishment and sales can occur later. Both engines retain sales on snapshot-zero dates while subtracting those dates from exposure (`current baseline.ts:258-265`; `original baseline.ts:93-99`).

Stress test with one sale every day and every daily snapshot zero gives 16.428571429/day in both baselines, versus observed one/day. This is a controlled contradictory/partial-day evidence case, not a claim it happened live, and downstream guardrails may limit the final forecast. Agree on treatment of sales-positive snapshot-zero dates and partial-day availability before declaring all such dates full stockouts.

### P3 — Tenant trading day versus UTC forecast/snapshot day

Current sales aggregation accepts tenant trading-day bucketing (`packages/shopify/src/sales.ts:89-106`), current forecast derives runDateKey from UTC (`packages/forecast-run/src/run.ts:455`), and snapshot writer uses UTC day (`apps/worker/src/snapshot-cron.ts:109`). Original forecast derives tenantTodayUtc/tenantDayKey (`lib/forecast/run-batch.ts:56-57`). Source-confirmed difference; this audit did not run a timezone integration test. Reproduce around tenant midnight and agree on a single business-day anchor before changing it.

## Current strengths to preserve

- **Distinct daily aggregation for spike and signal statistics.** Current `baseline.ts:88-100` sums channels first; original `baseline.ts:96` counts raw positive rows as sale days. Two channels selling one unit each on the same day plus 29 no-stock dates produces original 0.344359875/day versus current 0.153883685/day: original incorrectly qualifies for the tighter consistent-sales denominator floor.
- **Current spike damping is effective.** One 100-unit day amid an established one-unit/day series gives current 1.020547945/day, original default adjusted mean 3.034246575/day, original median 1/day. Original optional debulking exists separately (`lib/forecast/run-batch.ts:145-158`); this comparison is default baseline behavior, not every configuration.
- **Current future-row exclusion and short-history normalization** improve on the original as described above.
- **Explicit promo/closure exclusion from numerator and denominator.** Current handles distinct excluded dates; original optional promo scrubbing removes rows before the baseline (`lib/forecast/run-batch.ts:153-158`). Preserve the explicit exposure treatment and union de-duplication.
- **Confirmed full-stock snapshot coverage can disable inference.** Current supports empty mask plus coverage date; original empty mask always falls back to inference (`original baseline.ts:83`). Preserve this capability while replacing tenant-wide coverage with actual product evidence.

## Verification limits

The script calls real pure functions and verifies precise baseline examples; it does not query live stores, exercise sidecar model behavior, validate purchase quantity outputs, or certify dashboard consistency. Production guards, ABC floors, overrides, model selection, and report consumers are separate layers. Integration claims should be checked through the complete pipeline with identical input facts after the exposure rules are chosen.

## Implementation follow-up after user authorization

The audit above records the pre-change comparison. The pure forecast package now supports optional `baselineMethod: "mean" | "median"` on product/forecast inputs; absent/mean retains existing behavior. Established products opting into median use the original 56/182/364-day weights (0.5/0.3/0.2), with these intentional corrections:

- Completed-day half-open windows, aggregated daily quantities, and promo/closure exclusions from both quantity and exposure.
- Weekly totals divided by eligible days; entirely unavailable weeks omitted. At least three exposed days per week and four usable weeks required for median evidence.
- Per-window damped exposure mean fallback with fewer usable weeks, or median zero despite positive units, so sparse and heavily censored demand is not erased.
- Positive sales override a zero opening-stock snapshot as evidence of at least some exposure, unless that date is explicitly excluded as a promo/closure.
- The current snapshotsSince inference boundary is accepted; the separate audit finding about tenant-global coverage remains unresolved by this pure-module addition.
- Under-60-day products retain current short-history handling. Explicit owner median takes precedence over a recent_heavy audition champion. Owner demand overrides and downstream guardrails retain precedence.

The mathematically redundant twice-median cap was not copied. The shared default mean 60-day discontinuity was not changed by this feature port. Tests live in `packages/forecast/tests/baseline-median.test.ts`; the audit reproducer intentionally continues to demonstrate original/current-mean defects rather than acting as the new feature's acceptance test.

### Subsequent original bulk-control port

Added `packages/forecast/src/big-buyer.ts`: strict daily quantity > max(6, 5 times median positive day); cap target max(5, rounded 3 times median). The target floor follows upstream executable code, despite its contradictory prose saying 6. Daily channel/branch rows are aggregated before classification, then capped proportionally without rewriting revenue or original rows. Negative returns are preserved; net capped day still equals the target. Flags state `evidence: daily_total`, not a confirmed individual buyer. Optional asOf/excludedDates omit incomplete, future, promo and closure days from detection. Parent wiring adds an opt-in setting; the independent existing 2x spike cap remains.

Enabled damping now supplies cleaned evidence to rate, variability, safety stock, demonstrated-demand floor, historical cap and pipeline guardrail. Raw evidence remains for flags, actual-revenue ABC and backtest holdout quantities. Regression before the full-math fix showed demand standard deviation incorrectly remaining 5.2244 rather than the cleaned-series 1.4337; a dedicated test prevents that bypass.

Remaining named upstream controls found (inventory of differences, not newly enabled settings):

| Original feature | Source | Current difference |
|---|---|---|
| Post-promo dip, perishable/impulse exceptions | Original `lib/forecast/post-promo-dip.ts`; `run-batch.ts:232-239` | No equivalent option; upstream defaults to 21-day taper, 1/3 excess considered pulled-forward, maximum 40% reduction, configurable perishable types |
| Guardrail multiplier and thin-data ceiling | Original `lib/tenant/config.ts:77-78`; `run-batch.ts:222` | Current guardrail uses constant multiplier and pipeline does not expose thinCap as tenant control |
| Promo-spike exclusion toggle | Original `lib/tenant/config.ts:82` | Current exclusion mechanism is already on; missing toggle is not missing exclusion logic |
| Explicit TS/sidecar selection | Original `lib/tenant/config.ts:71` | Current forecastEnginePlan/audit-engine selection differs architecturally; not a field to copy blindly |

Generic unlogged spike suggestions already match original thresholds (>=8 units and >=3x median, 60-day baseline, 14-day suggestions, suppress known promos), but both old/current detector implementations retain row-level and inclusive-asOf behavior. The bulk module corrects these semantics for its own classification; it does not silently alter generic suggestions.
