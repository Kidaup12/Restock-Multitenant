"""Human-readable catalog of every forecasting model and combination.

Single source of truth for the API (`GET /api/models`) and the frontend
selector. `id` matches the registry / combo_registry key exactly; `family`
groups them for the UI; `default` marks what runs when the user selects
nothing (the spec's roster + C1).

This module does NOT construct models — it only names them. Roster assembly
lives in registry.py / combo_registry.py.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class ModelInfo:
    id: str
    name: str
    family: str          # naive | smoother | intermittent | seasonal | broad | combo
    intermittent: bool   # suited to sparse/dying demand
    default: bool        # in the default roster
    blurb: str


MODELS: list[ModelInfo] = [
    # --- naive floors ---
    ModelInfo("M1", "Naive (last week)", "naive", False, True,
              "Repeats last week's sales. The floor every model must beat."),
    ModelInfo("M2", "Seasonal naive (same week last year)", "naive", False, True,
              "Uses the same week 52 weeks ago. Needs a year of history and real seasonality."),
    ModelInfo("M3", "Naive with drift", "naive", False, True,
              "Last week plus the average weekly climb/fall. Assumes a trend continues."),
    # --- simple benchmarks / smoothers ---
    ModelInfo("M4_4", "Moving average (4w)", "smoother", False, True,
              "Mean of the last 4 weeks. Fast-reacting for fresh, fast-moving goods."),
    ModelInfo("M4_8", "Moving average (8w)", "smoother", False, True,
              "Mean of the last 8 weeks. Balanced benchmark."),
    ModelInfo("M4_13", "Moving average (13w)", "smoother", False, True,
              "Mean of the last 13 weeks. Steady staple forecaster."),
    ModelInfo("M5", "Winsorized median (13w)", "smoother", False, True,
              "Middle value of the last 13 weeks, capping flukes. Robust default champion."),
    ModelInfo("M6", "Exponential smoothing (SES)", "smoother", False, True,
              "Weighted average favouring recent weeks. Reacts fast, nearly unbiased."),
    ModelInfo("M7", "Theta", "smoother", False, True,
              "Smoothing plus a trend line. Strong general performer on richer data."),
    # --- intermittent specialists ---
    ModelInfo("M8", "Croston-SBA", "intermittent", True, True,
              "For sparse items: demand size / interval, bias-corrected. Doesn't decay dead items."),
    ModelInfo("M9", "TSB", "intermittent", True, True,
              "Croston variant whose forecast decays toward zero when an item stops selling. Best sparse default."),
    ModelInfo("M13", "Croston (original)", "intermittent", True, False,
              "Classic uncorrected Croston. Baseline for the SBA/TSB comparison."),
    ModelInfo("M14", "Croston-SBA (fitted alpha)", "intermittent", True, False,
              "SBA with the smoothing rate fitted per SKU instead of fixed."),
    ModelInfo("M15", "TSB (fitted alpha)", "intermittent", True, False,
              "TSB with both smoothing rates fitted per SKU."),
    ModelInfo("M16", "ADIDA", "intermittent", True, False,
              "Aggregates sparse weeks into blocks, forecasts, then splits back. Tames intermittency."),
    ModelInfo("M17", "Zero forecast", "intermittent", True, False,
              "Always predicts zero. A deliberate control for mostly-empty catalogues."),
    # --- broad statistical ---
    ModelInfo("M18", "Holt (linear trend)", "broad", False, False,
              "Level plus trend, both smoothed. Classic trended forecaster."),
    ModelInfo("M19", "Damped Holt", "broad", False, False,
              "Holt with a damped trend so long-range forecasts don't run away."),
    ModelInfo("M20", "Weighted moving average", "broad", False, False,
              "Moving average weighting recent weeks more heavily."),
    ModelInfo("M21", "Trimmed mean", "broad", False, False,
              "Mean of the last 13 weeks dropping the highest and lowest. Outlier-robust."),
    ModelInfo("M22", "Recency-weighted Poisson rate", "broad", True, False,
              "A demand-rate estimate with a recency half-life. Robust to zero weeks."),
    # --- seasonal ---
    ModelInfo("M10", "ETS (damped, multiplicative)", "seasonal", False, True,
              "Level + damped trend + seasonality. Needs two full years; for strong seasonal items."),
]

COMBOS: list[ModelInfo] = [
    ModelInfo("C1", "Median of 3 (M5+M7+M10)", "combo", False, True,
              "Median of a robust, a trended, and a seasonal model. The spec's best default combo."),
    ModelInfo("CC01", "Median (M5+M7+M10)", "combo", False, False, "Median-of-3: robust + trend + seasonal."),
    ModelInfo("CC02", "Median (M5+M9+M18)", "combo", False, False, "Median-of-3: robust + sparse + trended."),
    ModelInfo("CC03", "Median (M5+M6+M16)", "combo", False, False, "Median-of-3: robust + recency + aggregated-sparse."),
    ModelInfo("CC04", "Median (M5+M18+M21)", "combo", False, False, "Median-of-3: robust + trended + trimmed."),
    ModelInfo("CC05", "Mean (M5+M7+M9)", "combo", False, False, "Mean-of-3: robust + trend + sparse."),
    ModelInfo("CC06", "Mean (M6+M18+M20)", "combo", False, False, "Mean-of-3: recency + trend + weighted-MA."),
    ModelInfo("CC07", "Mean (M5+M16+M22)", "combo", False, False, "Mean-of-3: robust + aggregated + rate."),
    ModelInfo("CC08", "Trimmed mean of 5", "combo", False, False, "Trimmed mean: M5+M6+M7+M9+M18."),
    ModelInfo("CC09", "Trimmed mean of 5", "combo", False, False, "Trimmed mean: M4_8+M5+M6+M20+M21."),
    ModelInfo("CC10", "Trimmed mean of 5", "combo", False, False, "Trimmed mean: M5+M9+M16+M18+M22."),
    ModelInfo("CC11", "Inverse-error weighted (M5+M7)", "combo", False, False, "Weights by recent accuracy."),
    ModelInfo("CC12", "Inverse-error weighted (M5+M9)", "combo", False, False, "Robust + sparse, accuracy-weighted."),
    ModelInfo("CC13", "Inverse-error weighted (M5+M6+M9)", "combo", False, False, "Three members, accuracy-weighted."),
    ModelInfo("CC14", "Inverse-error weighted (M6+M18+M20)", "combo", False, False, "Broad trio, accuracy-weighted."),
    ModelInfo("CC15", "Two-layer (M5 base + M7 uplift)", "combo", False, False, "Robust baseline plus a trend uplift layer."),
    ModelInfo("CC16", "Two-layer (M5 base + M18 uplift)", "combo", False, False, "Robust baseline plus a Holt uplift layer."),
    ModelInfo("CC17", "Two-layer (M9 base + M16 uplift)", "combo", False, False, "Sparse baseline plus an aggregated uplift."),
    ModelInfo("CC18", "Median (M8+M9+M13)", "combo", True, False, "Intermittent-specialist median."),
    ModelInfo("CC19", "Median (M9+M15+M16)", "combo", True, False, "Intermittent-specialist median."),
    ModelInfo("CC20", "Mean (M9+M14+M22)", "combo", True, False, "Intermittent-specialist mean."),
]

ALL: list[ModelInfo] = MODELS + COMBOS
_BY_ID = {m.id: m for m in ALL}


def catalog() -> list[dict]:
    """JSON-serialisable list for the API / frontend."""
    return [asdict(m) for m in ALL]


def valid_ids() -> set[str]:
    return set(_BY_ID)


def default_roster_ids() -> list[str]:
    return [m.id for m in ALL if m.default]


def info(model_id: str) -> ModelInfo | None:
    return _BY_ID.get(model_id)
