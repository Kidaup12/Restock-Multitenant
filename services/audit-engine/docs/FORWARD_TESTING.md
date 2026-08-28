# How the engine tests forecasts (forward / backtest methodology)

This is the canonical description of how model accuracy is measured. It is not
a new proposal — it documents what the selection harness already does
(`src/audit_engine/selection/`) so the method is explicit and never quietly
drifts. If code and this doc disagree, one of them is a bug.

## The one-line version

**Stand at a past cutoff week, show each model only the weeks up to that cutoff,
have it predict the next 4 weeks, then compare against what actually sold. Slide
the cutoff forward 4 weeks and repeat.** Every accuracy number in the report is
an average of these forward tests — never a model scored on data it was fitted on.

## Why forward, never in-sample

A model scored on the same weeks it learned from will always look good — it has
seen the answer. That number does not survive contact with next month. So the
engine **only** reports rolling-origin forward tests: the model is refit at each
cutoff and predicts genuinely unseen future weeks. This is enforced, not trusted:
`models/base.py` hard-asserts a model receives exactly the pre-cutoff weeks and
raises `FutureLeakError` if it is ever handed a week at or past the origin.

## The mechanics (one origin)

```
weeks:  |........ train (cutoff and earlier) ........|  [gap]  | h1 h2 h3 h4 |
                                                    ^origin              ^ scored here
```

1. **Origin** = a cutoff week. Everything strictly before it is visible; nothing at
   or after it is.
2. Each model **refits** on the visible weeks (matches production: you retrain when
   you reorder).
3. Each model **predicts horizons 1–4** (the next 4 weeks; override with the
   client's real lead time via `selection.horizon_weeks`).
4. Those 4 predictions are compared to the actual sales that occurred → error.
5. Slide the origin forward `selection.step_weeks` (default 4) and repeat.

Config knobs (`config/defaults.yaml` → `selection`): `step_weeks`, `horizon_weeks`,
`training_window` (expanding), `selection_origins_*`, `validation_origins_*`.

## Two nested loops — why there are two blocks, not one

Running forward tests to *pick* a champion and then quoting that same champion's
score is still optimistic: it was chosen *because* it scored well on those weeks.
So the timeline is split:

- **Selection block** (earlier origins, target 10) — the inner loop. Scores every
  model across these origins and picks a champion per segment/strategy. These
  scores are used for *choosing*, so they are mildly flattering.
- **Validation block** (later origins, target 6) — the outer loop. The chosen
  champions are scored here on origins the selection never touched. This is the
  honest number.

The gap between the two is the **winner's curse**. It is measured, not assumed
(`selection/nested.py`, `selection_gap.parquet`). The validation block is
**touched once** — a marker file (`outer_touched.marker`) is written and a second
scoring is refused without `--force-revalidate`, because a holdout you peek at
twice is no longer a holdout.

## What we look at, and in what order

Per model, per segment (ABC × intermittency), per block:

- **WAPE** (primary) — total absolute error ÷ total actual volume. Lower is better.
  Reported, never MAPE (MAPE drops zero weeks, which are exactly the stockouts and
  intermittent weeks we most need to keep).
- **Bias** (signed %) — systematic over/under-forecast. **Reported beside WAPE and
  weighted at least as heavily.** On a mostly-zero catalogue you win WAPE by
  guessing low, so the low-WAPE model is often a chronic under-forecaster that
  would stock the client out. A model that is unbiased and slightly worse on WAPE
  is usually the right pick for ordering. (This is why Khwezibeauty routes to M9
  (TSB, bias ≈0%) over M5 (better WAPE, −37% bias).)
- **% of SKUs beating the naive floor** — reliability, not just the average.
- **Per-origin spread** — see next section.

## Read the per-origin sequence, not just the average

The single averaged WAPE hides the story. Score each origin separately and read
them top to bottom — this is the "test Feb, then Mar, then Apr" view. On real
catalogues accuracy is **unstable across time**: the same model swings from ~0.65
to ~1.5 depending on the month, and which model leads changes almost every origin.
That instability is itself a finding — it means the routing is provisional and
disrupted months (holidays, supply gaps) need a human eye, not blind automation.

`scripts/expanded_comparison.py` prints the aggregated table; the per-origin
breakdown comes from grouping `model_scores.parquet` by `origin_date`. A spike
across *all* models at the same origin is an event none of them could see (e.g.
the Dec–Jan sales dip on Khwezibeauty), not a model failure.

## The censoring caveat — why even the forward test is optimistic

The scoring weeks are censored the same way the training weeks are. If a SKU
stocked out in February and sold 4 units when true demand was 25, a model
predicting 5 looks brilliant and one predicting 24 looks terrible — so the harness
**rewards under-forecasting**. Mitigations, all applied:

1. Scoring weeks containing a High/Medium suspected stockout are **excluded**.
2. The excluded % is reported; above ~25% the selection is too thin to trust.
3. Negative bias across all models is **expected**, not reassuring.
4. The routing table is labelled **provisional** until a stock snapshot exists.
5. **No absolute accuracy claim is ever made** — only relative comparisons on
   identically-censored data, which stay valid.

The permanent fix is measured availability (the daily stock snapshot), which tells
us which low weeks were real demand and which were empty shelves. Until then,
forward-test accuracy is the best defensible estimate, not truth.

## Leakage smoke tests (run continuously)

- **Shuffle test** — shuffle the target; every model's error must collapse to the
  naive floor. If a model still looks good, it is leaking.
- **Future-blind assert** — the `FutureLeakError` guard inside every `fit`.
- **Horizon monotonicity** — error must grow as the horizon lengthens; if h=13
  beats h=4, something leaks.
- **Retro-tag audit** — price-based promo tags are recomputed per origin, never
  once globally, or a future promo leaks into a past forecast.

## Acceptance (validated on synthetic, known-answer data)

Because synthetic series are generated from known processes, the *correct*
champion is knowable, so the method itself is testable: trend → M7/M18, dying
item → M9/M15 (Croston M8/M13 must NOT win), pure noise → must not pick a complex
model, shuffle collapses to floor, validation-block gap > 0. See `SPEC.md` §15 and
`tests/`.
