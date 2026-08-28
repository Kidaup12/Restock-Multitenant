# Module contracts (binding for all build agents)

Ground rules for every agent:
- Working dir: `c:\Users\User\Documents\AntiG projects\Backtest Forward validation`
- Python env is ready: run things with `uv run python ...` / `uv run pytest tests/unit/test_<yours>.py -q`
- Do NOT edit `pyproject.toml`, `config/defaults.yaml`, `src/audit_engine/{config,schemas,types,panel,runctx}.py`, `src/audit_engine/models/base.py`, `src/audit_engine/availability/base.py`, or any file owned by another agent. If you need a dependency not installed, note it in your final report — do not install.
- Read `SPEC.md` (the functional spec) and the contract files above before writing code.
- All thresholds come from `Config` (`audit_engine.config`) — never hard-code a number that exists in `config/defaults.yaml`.
- Every rolling statistic must be trailing-window only (no full-sample stats). Rolling helpers live ONLY in `clean/trailing.py`; other modules import from there.
- pandera is imported as `import pandera.pandas as pa`.

## Shared objects (already written — import, don't redefine)

- `audit_engine.config`: `Config`, `load_config(defaults_path, client_path=None)`, `config_hash(cfg)`
- `audit_engine.schemas`: `TxSchema, StockSchema, PanelSchema, AuditLogSchema, StockoutSchema, BaselineSchema, SegmentSchema, ScoreSchema, CONFIDENCE_TIERS`
- `audit_engine.types`: `LogRow`, `HealthCheck`, `HealthReport`
- `audit_engine.panel`: `PanelMatrices`, `build_matrices(panel_df)`
- `audit_engine.models.base`: `BatchModel`, `FutureLeakError`, `masked_history`, `insufficient_history`
- `audit_engine.availability.base`: `AvailabilitySource`
- `audit_engine.runctx`: `RunContext`

## A. ingest (owner: agent-ingest)

Files: `src/audit_engine/ingest/loaders.py`, `src/audit_engine/ingest/health.py`, `tests/unit/test_ingest_health.py`, `tests/fixtures/ingest/*.csv`

```python
# loaders.py
def load_sales(path, config: Config, column_map: dict[str, str] | None = None) -> pd.DataFrame
    # tolerant CSV read: column aliasing (e.g. Date/date/order_date; SKU/sku/product_code;
    # quantity/qty/units; price/unit_price), date-format sniffing (dayfirst detection),
    # location default 'ALL', qty numeric, returns TxSchema-validated frame.
def load_stock(path, config: Config, column_map: dict[str, str] | None = None) -> pd.DataFrame
    # -> StockSchema-validated; negative on-hand clamped to 0 with a flag column '_negative_stock_clamped'.

# health.py
def run_health(tx: pd.DataFrame, stock: pd.DataFrame | None, config: Config) -> HealthReport
    # Implements every Phase-0 check in SPEC §3, each as a HealthCheck with metrics.
    # Go/no-go per SPEC: median SKU history < min_median_history_weeks; no price AND no cost;
    # >40% ambiguous zero-vs-null weeks; sales/catalogue unreconcilable.
def render_health_text(report: HealthReport) -> str   # human-readable console/markdown summary
```

## B. synth (owner: agent-synth)

Files: `src/audit_engine/synth/generator.py`, `synth/faults.py`, `synth/truth.py`, `tests/unit/test_synth.py`

```python
# generator.py
def generate(scenario: str = "full", seed: int = 42, n_weeks: int = 104,
             n_smooth: int = 60, n_intermittent: int = 60, n_seasonal: int = 20,
             config: Config | None = None) -> SynthResult

@dataclass
class SynthResult:
    sales: pd.DataFrame        # transaction-level, TxSchema-compatible (line-level rows w/ dates, prices)
    stock: pd.DataFrame        # StockSchema-compatible current on-hand
    truth: dict[str, pd.DataFrame]
    # truth keys: 'stockouts' (sku, location, start_date, end_date, days),
    # 'closures' (date), 'promos' (sku, week_start, uplift), 'spikes', 'bulk_orders' (order_id, sku, date, qty),
    # 'renames' (old_sku, new_sku, switch_date), 'level_shifts' (sku, week_start, factor),
    # 'true_rate' (sku, location, week_start, lambda_weekly)  # uncensored true demand rate
    def write_csvs(self, out_dir) -> dict[str, Path]   # sales.csv, stock.csv, truth_*.csv
```
Scenarios: "full" (all planted faults per SPEC §15), plus targeted ones: "stockouts_only", "closures", "promos", "intermittent", "clean", and model-process scenarios "proc_stable", "proc_trend", "proc_seasonal", "proc_intermittent", "proc_dying", "proc_noise" (pure known generating processes for harness acceptance). Deterministic per seed. Stockouts are planted by zeroing sales on known days of SKUs with known λ; true demand recorded in truth['true_rate'].

## C. clean (owner: agent-clean)

Files: `src/audit_engine/clean/trailing.py`, `clean/steps.py`, `clean/pipeline.py`, `clean/audit_log.py`, `tests/unit/test_clean.py`, `tests/properties/test_clean_props.py`

```python
# trailing.py — THE ONLY module allowed to compute rolling statistics
def trailing_median(values: np.ndarray, window: int) -> np.ndarray       # strictly past-only (shifted), NaN-aware
def trailing_median_df(df, group_cols, value_col, window) -> pd.Series   # per-group trailing median, past-only

# audit_log.py
class AuditLog:
    def extend(self, rows: list[LogRow]) -> None
    def to_frame(self) -> pd.DataFrame        # AuditLogSchema
    def write(self, path) -> None             # parquet

# pipeline.py
@dataclass
class CleanResult:
    panel: pd.DataFrame          # PanelSchema
    daily: pd.DataFrame          # (sku, location, date, units) daily spine used for stockout inference
    audit_log: pd.DataFrame      # AuditLogSchema
    episodes: pd.DataFrame       # StockoutSchema (from the availability source)
    excluded: pd.DataFrame       # excluded lines w/ reason (bulk, staff, dupes) for reporting

def run_chain(tx: pd.DataFrame, config: Config, availability: AvailabilitySource,
              sku_mapping: dict[str, str] | None = None,
              bundle_map: dict[str, list[tuple[str, float]]] | None = None) -> CleanResult
```
Implements SPEC §4's 17 steps in order; each step is a function in steps.py returning `(df, list[LogRow])`; pipeline owns the AuditLog. Steps 11–12 call `availability.in_stock_days(daily, config)` (the ABC — tests may use a stub). Step 13 caps correction at `config.availability.correction_cap_multiple`. Step 15 winsorizes at `winsorize_multiple ×` TRAILING median (use trailing.py), skipping promo/bulk-tagged weeks. Step 16 level-shift: `level_shift_consecutive_weeks` consecutive weeks above cap → stop capping from shift point, tag level_shift_flag. Property tests (hypothesis): appending future weeks never changes past corrected values; winsorize idempotent & never increases values; correction ≤ cap; filled zeros only inside [first_sale, last_sale] lifespan.

## D. availability + baseline + segments (owner: agent-avail)

Files: `src/audit_engine/availability/inferred.py`, `src/audit_engine/baseline/baseline.py`, `src/audit_engine/baseline/segments.py`, `tests/unit/test_availability.py`, `tests/unit/test_baseline.py`

```python
# inferred.py
class InferredAvailability(AvailabilitySource):
    def in_stock_days(self, daily, config) -> tuple[pd.DataFrame, pd.DataFrame]
    # SPEC §5: trailing λ per SKU (past-only; import trailing.py helpers if needed — but you may
    # compute a simple trailing mean daily rate locally via cumulative sums as long as it is past-only),
    # zero-run detection P=exp(-λk) < zero_run_pvalue, cross-sectional shares per candidate day,
    # tiers per SPEC §5 table, λ < min_velocity_per_day → not_assessable.
    # weekly out: (sku, location, week_start, in_stock_days, confidence); episodes: StockoutSchema.

# baseline.py
def compute_baseline(panel: pd.DataFrame, config: Config,
                     category_map: dict[str, str] | None = None,
                     as_of: pd.Timestamp | None = None) -> pd.DataFrame   # BaselineSchema
    # SPEC §6: trailing 13 usable non-event weeks, winsorize at 2x median-of-set, median.
    # Fallback ladder: 6-12 weeks -> low confidence; <6 -> cluster analog (category or correlation
    # cluster median), <4 weeks since launch -> not_assessable/launch; no sale in dormancy_weeks -> dormant.

# segments.py
def compute_segments(panel: pd.DataFrame, config: Config,
                     price_lookup: pd.DataFrame | None = None) -> pd.DataFrame  # SegmentSchema
    # ABC by trailing-52w value (units*price; fall back to units), XYZ by CV of weekly demand,
    # ADI/CV² per SPEC §7.7 -> demand_class, lifecycle (new <8w, dormant per config), routing
    # 'segment' cell: 'AX'..'CZ' or 'intermittent'/'new'/'dormant'.
```

## E. models (owner: agent-models)

Files: `src/audit_engine/models/{naive,median,smoothing,intermittent,ets,combos,registry}.py`, `tests/unit/test_models.py`

All subclass `BatchModel` (see base.py docstring for NaN/min-history semantics). SPEC §8: M1 naive_last; M2 naive_seasonal (52w); M3 naive_drift; M4 moving_average N∈{4,8,13} (ids `M4_4` etc.); M5 median_winsorized (13w trailing, cap 2× median-of-window); M6 SES with α grid-fitted on prefix, clamped to config `ses_alpha_bounds`; M7 Theta (SES on theta=2 line + half drift — standard M3-competition formulation); M8 Croston-SBA (×(1−α/2)); M9 TSB (probability-smoothed, decays for dying items); M10 ETS damped multiplicative via `statsmodels.tsa.exponential_smoothing.ets.ETSModel` per-series joblib-parallel, gated to series with ≥ ets_min_weeks usable history, fallback to M5 values on convergence failure. All except M10 vectorized across series (loop over weeks only).

```python
# registry.py
def build_roster(config: Config) -> dict[str, BatchModel]   # fresh instances per call, keyed by model_id
# combos.py — combination models wrap fitted member instances:
class MedianCombo(BatchModel): def __init__(self, members: list[BatchModel], model_id="C1")
class MeanCombo(BatchModel):   ...
class InverseErrorCombo(BatchModel): def __init__(self, members, weights: np.ndarray, floor=0.10)
def residual_correlation(pred_errors: dict[str, np.ndarray]) -> pd.DataFrame  # члены corr matrix
```
Combos' fit() fits each member on the same prefix; predict aggregates member predictions (NaN-aware: a member's NaN row is ignored for that series). Tests: closed-form checks (SES at α bound equals recursion; M1/M2/M3/M4 exact on constructed series; SBA bias factor; TSB decays to ~0 on a dying series; Theta on linear-trend series ≈ trend continuation), future-blind assert fires (test passes wider matrix and expects FutureLeakError), min-history → NaN rows.

## F. selection (owner: agent-select)

Files: `src/audit_engine/selection/{harness,scoring,nested,routing,smoke}.py`, `tests/unit/test_selection.py`

IMPORTANT: your unit tests must NOT import agent-E's concrete models (built in parallel). Define tiny stub BatchModel subclasses inside your test file. The registry is injected:

```python
# scoring.py
def wape(y_true, y_pred) -> float                       # sum|e|/sum|y|, NaN-pairs excluded
def signed_bias_pct(y_true, y_pred) -> float
def score_frame(scores: pd.DataFrame) -> pd.DataFrame   # per (block, model_id, segment?) WAPE/bias/n/pct_vs_floor
# harness.py
@dataclass
class BacktestResult: scores: pd.DataFrame; origins: list; excluded_pct: float; tier: str
def plan_origins(n_weeks_usable: int, cfg: SelectionCfg) -> dict  # tier: 'nested'|'inner_only'|'none', origin indices for selection/validation blocks
def run_backtest(mats: PanelMatrices, roster_factory: Callable[[], dict[str, BatchModel]],
                 config: Config, segments: pd.DataFrame | None = None,
                 blocks: tuple[str, ...] = ("selection",)) -> BacktestResult
    # rolling origins, expanding window, refit per origin per model, horizons 1..horizon_weeks,
    # scoring target = Y_corrected at origin_idx+h-1; exclude weeks where stockout_mask True
    # (exclusion_reason='censored') or usable False; ScoreSchema rows for every (model, sku, origin, h).
    # Promo leakage rule: any promo-derived feature must be recomputed from the prefix only.
# nested.py
def run_nested(mats, roster_factory, config, segments, run_dir: Path) -> dict
    # plan_origins -> selection block backtest -> pick champions (routing.py S0/S1/S2) ->
    # validation block scored ONCE: writes 'outer_touched.marker' + validation_log.txt in run_dir,
    # raises if marker exists (unless force=True). Returns dict with scores, routing, selection_gap,
    # winner_stability, strategy comparison.
# routing.py
def pick_champions(scores_sel: pd.DataFrame, segments: pd.DataFrame, config) -> pd.DataFrame
    # strategies S0/S1/S2 per SPEC §10 incl. S2 guardrails; returns per-strategy champion tables
def routing_table(champions: pd.DataFrame, validation_scores: pd.DataFrame, config) -> dict  # -> YAML-able
def winner_stability(scores_sel) -> pd.DataFrame        # champion flip rate per sku between consecutive origins
def selection_gap(sel_scores, val_scores) -> pd.DataFrame  # per strategy: val WAPE - sel WAPE
# smoke.py
def shuffle_test(mats, roster_factory, config, seed=0) -> pd.DataFrame   # shuffled targets -> all ≈ floor
def horizon_monotonicity(scores) -> pd.DataFrame                          # WAPE non-decreasing in h
```

## G. findings + report (owner: agent-report)

Files: `src/audit_engine/findings/{lost_sales,stock_position,catalogue,data_quality}.py`, `src/audit_engine/report/{html.py,workbook.py}`, `src/audit_engine/report/templates/report.html.j2`, `tests/unit/test_findings.py`

```python
# findings/lost_sales.py
def lost_sales(episodes, baseline, panel, config) -> dict
    # keys: 'by_sku' df (sku, location, stockout_days, episodes, lost_units_low, lost_units_high,
    # lost_revenue_low, lost_revenue_high, confidence), 'by_month' df, 'total' dict
    # {units_low, units_high, revenue_low, revenue_high}; band per SPEC §7.1 (low=High-tier only;
    # high=High+Medium + not-assessable allowance scaled by value share). median selling price from panel.
def repeat_offenders(episodes, config) -> pd.DataFrame   # ≥ repeat_offender_episodes episodes
# findings/stock_position.py
def stock_position(stock, baseline, panel, segments, config) -> dict
    # 'cover' df (sku, location, qty_on_hand, weeks_of_cover, bucket), bucket per SPEC §7.4 table,
    # 'dead_stock' df bucketed 8-12/13-26/26+ w by last-sale age, value=qty*unit_cost,
    # 'runouts' df (A-class cover < runout_cover_weeks), 'capital' dict totals
# findings/catalogue.py
def catalogue_structure(segments, panel, config) -> dict   # ABC concentration curve stats + forecastability split shares
# findings/data_quality.py
def data_quality_findings(health: dict, audit_log: pd.DataFrame, config) -> dict  # health = HealthReport.to_dict()

# report/html.py
def render_report(context: dict, out_path: Path) -> Path   # Jinja2, self-contained HTML (inline CSS), print-friendly
# context keys: 'client', 'run_id', 'generated', 'exec_summary' {lost_sales_range, dead_stock_value,
# capital_tied_up}, 'immediate_actions', 'lost_sales', 'stock_position', 'catalogue', 'routing'
# (may be None in Phase A), 'data_quality', 'limitations' (list[str] — MANDATORY section
# "What we could not see"), 'recommendations'. Missing/None sections render gracefully.
# report/workbook.py
def write_workbook(out_path: Path, sheets: dict[str, pd.DataFrame]) -> Path  # xlsxwriter, frozen header, autofilter, currency/number formats
```
Report structure per SPEC §12 (9 sections, exec summary = 3 numbers, every money figure a range). No absolute-accuracy claims anywhere in template text.

## Integration (owner: main agent — do not build)

`src/audit_engine/cli.py` (typer: health/run/synth/backtest) is wired by the main agent after all modules land.
