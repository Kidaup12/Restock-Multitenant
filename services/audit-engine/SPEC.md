# Retail Inventory Audit Engine — Build Plan (v1)

**Scope:** a diagnostic engine that takes a client's sales history plus a current stock export and produces a paid audit report identifying lost sales, dead stock, overstock, and data quality problems.

**Explicitly not:** a forecasting platform, an ordering system, or a replenishment tool. Those come in v2, funded by v1 and fed by data v1 tells clients to start collecting.

---

## 1. Why this shape

An ordering engine commits money on every forecast, so systematic bias is expensive and stockout blindness is disqualifying. An audit engine only has to be directionally right about what already went wrong. Being 15% off on a baseline is acceptable when the finding is *"you were out of stock 47 days and it cost you roughly £8k."*

This inverts the main weakness. Not having stockout data stops being the thing that breaks the model and becomes the headline finding — the client's POS reports cannot show them this, and it is the single number that gets attention in the room.

**Design principles**

| Principle | Consequence |
|---|---|
| Findings over forecasts | Models are compared to produce a *recommendation*, not to place orders |
| Two nested loops | The method of picking a model is itself tested, never assumed |
| Robust over accurate | Winsorized median everywhere; contamination is invisible so statistics must tolerate it |
| Ranges over points | Every money figure is a band with stated assumptions |
| Halt over guess | Missing data stops the pipeline; it never forecasts through a gap |
| Pluggable availability | Inferred today, snapshot-driven later, same interface |
| Audit log on every rule | Any number can be traced to the rows and rules that produced it |

---

## 2. Data requirements

### Required

**Sales lines** — transaction level, minimum 26 weeks, ideally 104

| Field | Required | Notes |
|---|---|---|
| date | Yes | Order date, not ship date |
| sku | Yes | |
| location | If multi-site | Defaults to single |
| qty | Yes | Negative for returns |
| unit_price | Strongly wanted | Unlocks promo detection and money figures |
| discount | Preferred | Else derived from price vs. mode |
| order_id | Preferred | Needed for bulk-order detection |
| customer_type | Preferred | Retail / wholesale / staff |
| line_type | Preferred | sale / return / exchange |
| channel | Optional | |

**Current stock on hand** — one export, today's numbers only, not history

| Field | Required |
|---|---|
| sku | Yes |
| location | If multi-site |
| qty_on_hand | Yes |
| unit_cost | Strongly wanted |

Almost every client can produce this from their POS in a few clicks, and it unlocks roughly half the audit on its own — cover, dead stock, overstock, imminent runouts — none of which need history.

### Wanted, not required

| Dataset | What it adds | Fallback if absent |
|---|---|---|
| Category / product type | Seasonality pooling, segment reporting | Correlation clustering |
| Cost per SKU | Margin-based lost profit | Report units and revenue only |
| Promo calendar | Clean event tagging | Price-based retro detection |
| Supplier lead times | Runout urgency | Flag on cover alone |

Ask for a category column even from clients who have nothing else. It is the cheapest field with the highest analytical payoff.

### Deliberately not requested for v1

Stock history, receipts, purchase orders, supplier data. Asking for these produces delay and excuses. The audit is designed to work without them, and the report's closing section is what convinces the client to start producing them.

---

## 3. Phase 0 — Data health audit

Runs before anything else. Output is a go/no-go plus the first section of the client report.

### Checks

| Check | Computed | Threshold |
|---|---|---|
| History depth | Weeks per SKU, distribution | Report % at ≥104w, ≥52w, ≥26w, <26w |
| Zero vs. null | Are absent weeks real zeros or missing rows? | Any ambiguity → flag |
| Catalogue coverage | SKUs in sales but not catalogue, and vice versa | >10% mismatch → flag |
| Volume continuity | Week-on-week total units | Any ±60% jump → investigate |
| Intermittency profile | % of catalogue with ADI ≥ 1.32 | Expect 50–80% |
| SKU churn | Launches + discontinuations per quarter | Sets cold-start weight |
| History truncation | SKUs whose first sale is suspiciously recent | Suggests renames |
| Return lag | Distribution of return-to-sale gap | Sets netting window |
| Line quantity distribution | Percentiles per SKU | Sets bulk threshold |
| Price availability | % of lines with usable price | <80% → no money figures |
| Duplicate lines | Exact and near matches | Dedupe, log count |
| Negative stock | On-hand < 0 | Treat as zero, flag |

### Go / no-go

**Stop and report** if any of:

- Median SKU has < 13 weeks of history
- No price data and no cost data (nothing can be monetised)
- \> 40% of weeks are ambiguous zero-vs-null
- Sales file cannot be reconciled to catalogue at all

None of these is a failed engagement. Each is a finding, and the deliverable becomes a data remediation plan.

---

## 4. Preprocessing chain

Strict fixed order. Every step writes to the audit log.

```
 1. Schema validation                    → halt on failure
 2. Deduplicate order lines
 3. Resolve SKU renames via mapping      → unmapped = new
 4. Exclude non-demand lines             (staff, test, cancelled, fraud)
 5. Net returns to original sale date
 6. Flag bulk orders (>5x median line qty) → exclude from baseline, keep for reporting
 7. Explode bundles to components         (if bundle map supplied)
 8. Aggregate to SKU x location x week
 9. Fill true zeros                       (only within active lifespan)
10. Retro-detect promo weeks from price   → tag
11. Infer stockout days                   → see section 5
12. Compute in-stock days per week
13. Availability correction               (units / in-stock days, cap 1.5x)
14. Drop weeks below coverage minimum     (<3 in-stock days)
15. Winsorize untagged spikes             (2x trailing median)
16. Level-shift detection                 (4 consecutive above cap → reset baseline)
17. Emit clean panel + audit log
```

**Every rolling statistic uses trailing windows only.** Trailing medians, winsorization thresholds, level-shift detection. Full-sample statistics are the most common source of self-flattering results and they are invisible once computed.

**Audit log schema**

```
sku, location, week, step_number, rule_name,
value_before, value_after, reason, confidence
```

---

## 5. Stockout inference

The core technical piece, and the source of the headline finding.

### Zero-run detection

For a SKU with baseline daily rate λ, the probability of k consecutive zero-sale days under a Poisson assumption is:

```
P(k zeros) = exp(-λ * k)
```

Flag a run as a suspected stockout when `P < 0.01`.

Worked example — face cream, baseline 20/week, λ ≈ 2.86/day:

| Zero run | P | Verdict |
|---|---|---|
| 1 day | 0.057 | Normal |
| 2 days | 0.003 | Suspicious |
| 6 days | 3.5e-8 | Near-certain stockout |

### Cross-sectional check

For every candidate zero-run day, compute what share of the *active* catalogue also sold zero.

| Share of catalogue at zero | Interpretation | Action |
|---|---|---|
| < 20% | Genuine SKU-level stockout | Exclude those days from denominator |
| 20–60% | Ambiguous | Flag, exclude from money figures |
| > 60% | Closure, holiday, or feed outage | Exclude day for all SKUs, no lost-sales claim |

### Applicability gate

```
if baseline_daily_rate < 1.0:
    stockout_inference = unavailable
```

Below roughly 7 units/week, zero runs are normal and inference is worthless. Report these SKUs in an explicit *not assessable* bucket.

### Confidence tiers

| Tier | Condition |
|---|---|
| High | λ ≥ 3/day, P < 0.001, cross-sectional < 20% |
| Medium | λ ≥ 1/day, P < 0.01, cross-sectional < 20% |
| Low | Meets threshold but cross-sectional 20–60% |
| Not assessable | λ < 1/day |

Money figures use High and Medium only. Low appears in counts, not in the total.

---

## 6. Baseline calculation

Deliberately simple. This is a defensible "normal week," not a forecast.

```
1. Take trailing 13 weeks of availability-corrected weekly rates
2. Drop weeks failing coverage or tagged as events
3. Require >= 6 usable weeks, else fall back (below)
4. Winsorize each remaining week at 2x the median of the set
5. baseline_weekly = median(winsorized weeks)
6. baseline_daily  = baseline_weekly / 7
```

**Fallbacks**

| Situation | Rule |
|---|---|
| 6–12 usable weeks | Use what exists, mark low confidence |
| < 6 usable weeks | Cluster-median analog, mark low confidence |
| < 4 weeks since launch | Not assessable — launch burst is not demand |
| No sale in 8+ weeks | Dormant — no baseline, route to dead stock findings |

**Seasonal adjustment** is applied only where 2+ years exist. Otherwise pool across correlation clusters (or supplied categories) and apply the cluster index.

**No trend extrapolation in v1.**

---

## 7. Findings

Each finding is a formula, a money figure, and a confidence band.

### 7.1 Lost sales from stockouts — the headline

```
lost_units    = baseline_daily * stockout_days      (High + Medium confidence only)
lost_revenue  = lost_units * median_selling_price
lost_margin   = lost_units * (price - cost)
```

Report by SKU, by month, and as a catalogue total. Rank by value.

**Band:** low estimate uses High confidence only; high estimate uses High + Medium + an allowance for the not-assessable bucket, scaled by its share of value.

### 7.2 Repeat offenders

SKUs with ≥3 separate stockout episodes in the window.

### 7.3 Dead stock

```
dead = no sale in >= 8 weeks AND qty_on_hand > 0
value = qty_on_hand * unit_cost
```

Segment by 8–12w, 13–26w, 26w+. The last bucket framed as a write-off decision.

### 7.4 Overstock and cover

```
weeks_of_cover = qty_on_hand / baseline_weekly
```

| Cover | Bucket |
|---|---|
| > 26 weeks | Severe overstock |
| 12–26 weeks | Overstock |
| 4–12 weeks | Healthy |
| 1–4 weeks | Thin |
| < 1 week | Imminent runout |
| Dormant + stock | Dead |

### 7.5 Imminent runouts

Cover < 2 weeks on A-class items, as of the export date.

### 7.6 Concentration

ABC by trailing 52-week value.

### 7.7 Forecastability assessment

```
ADI  = mean interval between non-zero weeks
CV^2 = (std / mean)^2 of non-zero demand

ADI >= 1.32 and CV^2 >= 0.49  → intermittent, rules not forecasts
ADI <  1.32 and CV^2 <  0.49  → smooth, forecastable
otherwise                     → erratic or lumpy, wide bands only
```

### 7.8 Data quality findings

Straight from the Phase 0 audit and the preprocessing log.

### 7.9 Recommended starting model

Which forecasting method to start with, per segment, chosen by evidence (sections 8–10). Output is a routing table plus the caveat that selection on censored history is provisional.

---

## 8. Model roster

Every model implements the same interface, no exceptions:

```python
class Model:
    def fit(self, panel, origin_date) -> None:
        """Must not read a single row past origin_date."""
    def predict(self, horizons) -> DataFrame:
        """Point forecast in v1. Quantiles added in v2."""
    min_history_weeks: int
    handles_intermittent: bool
```

All models consume the **availability-corrected, winsorized panel** from section 4. None of them see raw sales.

### The ten

| # | Model | What it does | Min history | Intermittent | Role |
|---|---|---|---|---|---|
| M1 | `naive_last` | Last observed week | 1w | — | Floor |
| M2 | `naive_seasonal` | Same week last year | 52w | — | Floor (seasonal) |
| M3 | `naive_drift` | Last + average weekly change | 8w | — | Floor (trend) |
| M4 | `moving_average` | Mean of last N (N = 4, 8, 13) | N | — | Simple benchmark |
| M5 | `median_winsorized` | Median of trailing 13, capped at 2× median | 6w | — | **Default champion** |
| M6 | `ses` | Exponential smoothing, α fitted, clamped 0.05–0.4 | 8w | — | Recency weighting |
| M7 | `theta` | SES + drift decomposition | 13w | — | Strong general performer |
| M8 | `croston_sba` | Demand size ÷ interval, bias-corrected | 13w | Yes | Sparse items |
| M9 | `tsb` | Croston variant; demand *probability* decays | 13w | Yes | Sparse + dying items |
| M10 | `ets_damped_mult` | Level + damped trend + multiplicative seasonality | 104w | — | Seasonal items |

**Notes that matter**

- **M5 is the presumed champion.**
- **M4** is three configs, scored separately.
- **M6** α must be clamped 0.05–0.4.
- **M7 (Theta)** — M3-competition winner, ~20 lines of code.
- **M8 vs M9** — SBA corrects Croston's upward bias; TSB decays toward zero when an item stops selling. Prefer M9 as the intermittent default.
- **M10** needs two full seasons; below that it invents seasonality from noise.

### Two stretch models (build only after the ten pass the harness)

| # | Model | Adds | Requires |
|---|---|---|---|
| M11 | `decomposition_pooled` | `baseline × cluster_seasonal_index × event_uplift × price_factor` | Price data, 20+ SKU clusters |
| M12 | `lgbm_global` | One model across all SKUs | ~500+ series |

---

## 9. Combinations

### Diversity is the actual ingredient

**Hard gate before any combination ships:** compute the correlation matrix of member residuals across the backtest. Any pair above **0.90** — drop one.

Diverse trio: **M5** + **M7** + **M11 or M10**.

### The combinations

| # | Combination | Rule | Notes |
|---|---|---|---|
| C1 | `median_of_3` | Median of M5, M7, M10/M11 | **Best default** |
| C2 | `mean_of_3` | Arithmetic mean, same members | |
| C3 | `trimmed_mean_5` | Drop highest and lowest of 5, average rest | |
| C4 | `inverse_error_weighted` | Weight ∝ 1 / rolling WAPE over last 8 origins | Weight floor 0.10 |
| C5 | `segment_routed` | Routing table: one champion per segment | Usually the shippable answer |
| C6 | `two_layer` | Robust baseline (M5) + separate event uplift layer | |
| C7 | `parent_disaggregated` | Forecast at parent SKU, split by historical variant mix | |

### When not to combine

- **Intermittent items** — route to M9, exclude from ensembles.
- **When one model dominates** a segment across 15 origins.
- **When you must explain the number** — run C1 for the number, M11 for the explanation, flag divergence.

### What combining cannot fix

Shared blind spots (stockout censoring, untagged promos, bulk orders, broken feeds) survive ensembling. Fixing the availability denominator ≈ 20–40% error reduction; diversified combination ≈ 5–15%.

---

## 10. Selection harness

A miniature rolling-origin backtest, run inside the audit, producing the routing table in finding 7.9.

### Two nested experiments

- **Inner loop** — scores M1–M12 and C1–C7 across rolling origins on the SELECTION block, picks a champion per SKU or segment.
- **Outer loop** — scores the chosen champion on the VALIDATION block, which the inner loop never touched. The gap between them is the winner's curse, quantified.

### Design

```
|-------- train --------|gap|---- selection block ----|---- validation block ----|
  ↓ roll the whole frame forward, repeat
```

| Setting | Value |
|---|---|
| Selection origins | Target 8–12, minimum 6 |
| Validation origins | Target 4–8, minimum 3 |
| Step | 4 weeks |
| Horizon | 4 weeks default; client lead time if known |
| Training window | Expanding |
| Gap | Match data lag (usually 0) |
| Refit | Every origin |
| Validation block | **Touched once**, logged when |

**History gate — three tiers**

```
weeks_needed = 13 (min train) + horizon + (selection_origins + validation_origins) * step
```

| Usable weeks | What runs |
|---|---|
| **≥ 65** | Full nested: inner + outer, routing table with measured selection gap |
| **49–64** | Inner loop only, champion flagged **unvalidated** |
| **< 49** | Nothing — default to M5, state history too short |

### Scoring

| Metric | Purpose |
|---|---|
| **WAPE** | Primary |
| **Bias** (signed %) | Reported separately, never buried |
| **% of SKUs losing to M2** | Reliability |
| **Origin-level spread** | Variance context |

**Never MAPE.** Every result reported as % better than the naive floor (M2 where 52w exists, else M1).

### The censoring problem — mandatory mitigations

1. **Exclude any scoring week containing a suspected stockout** (High or Medium)
2. **Report the excluded percentage** — above ~25%, selection result too thin
3. **Expect negative bias** across all models
4. **Label the routing table provisional**
5. **No absolute accuracy claims** — only relative comparisons

### Selection strategies — test, don't assume

| Strategy | Description |
|---|---|
| **S0** | Single model for everything (control — M5) |
| **S1** | Per-segment selection: champion per ABC×XYZ×intermittency cell |
| **S2** | Per-SKU selection, unrestricted |

Champions picked on the SELECTION block only; all three scored on the VALIDATION block.

**Diagnostics:**

- **Winner stability** — champion flip rate between consecutive origins; >40% = fitting noise
- **Selection gap** — mean (validation error − selection error) per strategy. Expect S2 ≫ S1 > S0 ≈ 0
- **Margin distribution** — per-SKU winner vs segment champion; median below origin-level SE = nothing there

**Prediction (written in advance): S1 wins.**

**S2 override guardrails:**

```
sku_origins       >= 12
margin_vs_segment >= 5% relative AND >= 1 SE of origin-level error
winner_stable     across >= 2 consecutive selection windows
fallback          = segment champion on any data-quality flag
```

### Expected routing table

| Segment | Likely champion | Fallback |
|---|---|---|
| AX | M7 or C1 | M5 |
| AY / AZ | C1 | M5 |
| BX / BY | M5 | M4(8) |
| C | M5 or M4(13) | M1 |
| Intermittent (ADI ≥ 1.32) | M9 | M8 |
| Dormant | M9 | No forecast |
| New (< 8 weeks) | Cluster analog | No forecast |
| Strong seasonal, 104w+ | M10 or M11 | M7 |

### Leakage smoke tests (run continuously)

- **Shuffle test** — shuffle targets; error must collapse to naive level
- **Future-blind assert** — hard assertion inside `fit()`; fail loudly
- **Horizon monotonicity** — error must worsen as horizon grows
- **Full-sample scan** — no aggregation not windowed to trailing data
- **Retro-tag audit** — promo detection recomputed per origin, never once globally

### Output artefacts

```
/runs/{client}/{run_id}/
  model_scores.parquet
  winner_stability.parquet
  selection_gap.parquet
  validation_log.txt
  selection_analysis.md
  residual_corr.parquet
  routing_table.yaml
```

---

## 11. Uncertainty and honesty

**Every money figure is a range.** Every report contains a section titled **"What we could not see"**: SKUs below velocity threshold + their value share, stockouts shorter than detection threshold, ambiguous closure days, missing price/cost data, history depth limits. **Never claim absolute forecast accuracy.**

---

## 12. Report structure

PDF (v1: HTML) plus a spreadsheet of SKU-level detail.

```
1. Executive summary          — 3 numbers: lost sales, dead stock, capital tied up
2. Immediate actions          — imminent runouts, repeat offenders. One page.
3. Lost sales analysis        — total, by month, top 20 SKUs, method note
4. Stock position             — cover distribution, dead stock, overstock
5. Catalogue structure        — ABC, forecastability split
6. Recommended starting model — routing table, evidence, provisional caveat
7. Data quality               — what's broken, what it costs
8. What we could not see      — limitations, stated plainly
9. Recommendations            — reorder points, snapshot script, path to v2
Appendix: methodology, SKU-level workbook
```

---

## 13. Architecture

```
audit_engine/
  config/          # defaults.yaml + client overrides
  ingest/          # schema validation, CSV/Excel loaders
  clean/           # 17 ordered steps, rules, audit log
  availability/    # base interface + inferred (v1) + snapshots (v2)
  baseline/        # robust median, seasonality pooling, segments
  models/          # base interface, M1-M12, combinations
  selection/       # harness, scoring, strategies, diagnostics, leakage
  findings/        # stockouts, dead stock, cover, concentration, recommended model, data quality
  report/          # builder + templates
  validate/        # synthetic generator + tests
```

**Availability interface:**

```python
class AvailabilitySource:
    def in_stock_days(self, sku, location, week) -> tuple[float, str]:
        """Returns (days, confidence_tier)"""
```

---

## 14. Config (defaults)

```yaml
time:
  bucket: weekly
  week_start: monday
  date_basis: order_date

demand:
  bulk_order_threshold_multiple: 5
  returns_netted_to: original_sale_date
  exclude_types: [staff, test, cancelled, fraud]

availability:
  source: inferred
  zero_run_pvalue: 0.01
  min_velocity_per_day: 1.0
  cross_sectional_closure_threshold: 0.60
  cross_sectional_ambiguous_threshold: 0.20
  correction_cap_multiple: 1.5
  min_instock_days_per_week: 3

baseline:
  statistic: median
  window_weeks: 13
  min_usable_weeks: 6
  winsorize_multiple: 2.0
  level_shift_consecutive_weeks: 4
  trend: none

events:
  detection: price_based_retro
  price_drop_threshold_pct: 15

seasonality:
  min_years_for_own: 2
  fallback: cluster_pooled
  min_cluster_size: 20
  index_bounds: [0.4, 3.0]

segments:
  abc_thresholds: [0.80, 0.95]
  xyz_cv_thresholds: [0.5, 1.0]
  intermittent_adi: 1.32
  intermittent_cv2: 0.49
  dormancy_weeks: 8

models:
  roster: [M1, M2, M3, M4_4, M4_8, M4_13, M5, M6, M7, M8, M9, M10]
  stretch: [M11, M12]
  default_champion: M5
  intermittent_default: M9
  ses_alpha_bounds: [0.05, 0.40]
  ets_min_weeks: 104
  seasonal_naive_min_weeks: 52

combinations:
  enabled: [C1, C5, C6]
  members_c1: [M5, M7, M11]
  residual_corr_max: 0.90
  inverse_error_weight_floor: 0.10
  exclude_intermittent: true

selection:
  nested: true
  selection_origins_target: 10
  selection_origins_minimum: 6
  validation_origins_target: 6
  validation_origins_minimum: 3
  step_weeks: 4
  horizon_weeks: 4
  training_window: expanding
  min_weeks_nested: 65
  min_weeks_inner_only: 49
  below_minimum: default_to_M5
  validation_block_touches: 1
  strategies: [S0, S1, S2]
  primary_metric: wape
  floor_model: M2
  exclude_censored_score_weeks: true
  max_excluded_pct: 25
  per_sku_override:
    min_origins: 12
    min_margin_pct: 5
    require_stability_windows: 2
  status: provisional

findings:
  dead_stock_weeks: [8, 13, 26]
  overstock_cover_weeks: [12, 26]
  runout_cover_weeks: 2
  repeat_offender_episodes: 3
  money_figures_min_confidence: medium

reporting:
  ranges_required: true
  claim_absolute_accuracy: false
  limitations_section: mandatory

data_quality:
  max_null_zero_ambiguity_pct: 40
  volume_change_alert_pct: 60
  min_median_history_weeks: 13
  on_failure: halt_and_report
```

---

## 15. Validation

### Synthetic generator — planted faults

| Planted fault | Tests |
|---|---|
| Stockouts of 2, 5, 10, 20 days at known dates | Detection rate and precision |
| Whole-catalogue closure days | Closure vs. stockout separation |
| Promo weeks at known uplift | Retro-detection and baseline protection |
| Single influencer spike | Winsorization |
| Bulk wholesale orders | Bulk exclusion |
| SKU rename mid-history | Mapping and truncation flag |
| Level shift from channel launch | Shift detection vs. over-capping |
| Intermittent items | Correct routing to not-assessable |
| Missing data weeks | Halt behaviour |
| Returns netted late | Date attribution |

### Acceptance criteria

| Metric | Target |
|---|---|
| Stockout recall, λ ≥ 3/day, runs ≥ 3 days | ≥ 90% |
| Stockout precision, same band | ≥ 85% |
| False positives on intermittent items | ≤ 5% |
| Closure days misread as stockouts | ≤ 2% |
| Lost-units estimate vs. planted truth | Within ±20%, inside stated band ≥ 90% of runs |
| Baseline vs. planted true rate | Within ±15% on smooth SKUs |
| Promo weeks excluded from baseline | ≥ 90% |

### Selection harness acceptance criteria

| Planted process | Correct champion | Target |
|---|---|---|
| Stable + noise | M5 or M4 | ≥ 80% |
| Trend + noise | M3 or M7 | ≥ 75% |
| Strong annual seasonality, 104w | M10 | ≥ 75% |
| Intermittent (ADI 3.0) | M9 or M8 | ≥ 90% |
| Dying item (demand → 0) | M9 specifically | ≥ 90% — M8 must not win |
| Pure white noise | M5 or floor | Must NOT pick a complex model |

Additional gates: shuffle test collapses all models to floor; horizon monotonicity holds; winner flip rate on white noise ≥ 60%; S1 beats S2 out-of-sample on short history; S2 selection gap > S1 gap; S0 gap ≈ 0; on pure-noise catalogue S2 gap large and positive.

**Reproducibility:** same config hash + same input snapshot → identical output.

### Live sanity checks (per engagement)

- Manually trace 10 SKUs raw → findings
- Check top 5 lost-sales SKUs against client recollection
- Clean-panel totals reconcile to raw file within documented exclusions

---

## 16–20. Build sequence, engagement workflow, snapshot handoff, kill criteria, path to v2

Stages: 1 schema/loaders/Phase 0 → 2 preprocessing+log → 3 baseline → 4 synthetic generator → 5 stockout inference → 6 lost sales → 7 stock position → 8 segmentation → 9 model interface+M1–M5 → 10 harness+scoring → 11 M6–M10 → 12 nested loop → 12b strategies+diagnostics → 13 combos → 14 routing table → 15 report builder → 16 snapshot script → 17 second client.

**Do not start at Stage 9.** Stages 1–8 make 9–14 mean anything. Snapshot handoff: daily `date, sku, location, qty_on_hand` capture — cannot be backfilled. Kill criteria include: stockout recall <70% on synthetic after two iterations; no model beats naive floor by >10% on A-items; >25% scoring weeks censored.
