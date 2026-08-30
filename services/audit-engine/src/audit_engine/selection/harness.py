"""Rolling-origin backtest harness (SPEC §10).

Layout (indices counted back from the END of the usable panel, n = usable weeks):

    |------ train (expanding) ------|---- selection block ----|---- validation block ----|
                                     sel_origins x step weeks   val_origins x step weeks

* validation block = the LAST ``val_origins * step`` weeks; its origins are
  ``n - k*step`` for k = val..1 (ascending).
* selection block sits immediately before it; its origins are ``n - k*step``
  for k = sel+val .. val+1 (ascending).
* the earliest selection origin leaves an expanding training prefix of at
  least ``min_train_weeks + horizon`` weeks because
  ``weeks_needed = min_train + horizon + (sel + val) * step <= n``.

An origin index j means: fit on weeks [0, j), forecast horizon h scores
against the week at index j + h - 1 (so h=1 is the origin week itself, the
first unseen week). With horizon <= step, selection-block targets can never
touch the validation block.

Censoring mitigations (SPEC §10): any target week flagged as a High/Medium
suspected stockout is excluded from scoring (exclusion_reason='censored') and
the censored share among otherwise-scoreable rows is reported as excluded_pct.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

import numpy as np
import pandas as pd

from ..models.base import BatchModel
from ..panel import PanelMatrices

__all__ = ["BacktestResult", "plan_origins", "run_backtest", "empty_scores", "SCORE_COLUMNS"]

MIN_TRAIN_WEEKS = 13  # SPEC §10: weeks_needed = 13 (min train) + horizon + origins*step

SCORE_COLUMNS = [
    "block", "origin_date", "model_id", "sku", "location",
    "horizon", "y_true", "y_pred", "scored", "exclusion_reason",
]


@dataclass
class BacktestResult:
    scores: pd.DataFrame
    origins: list = field(default_factory=list)
    excluded_pct: float = 0.0   # % of otherwise-scoreable rows lost to censoring
    tier: str = "none"


def _selection_cfg(cfg):
    """Accept either the full Config or a bare SelectionCfg."""
    return cfg.selection if hasattr(cfg, "selection") else cfg


def empty_scores() -> pd.DataFrame:
    """Empty ScoreSchema-shaped frame with correct dtypes."""
    return pd.DataFrame(
        {
            "block": pd.Series(dtype=str),
            "origin_date": pd.Series(dtype="datetime64[ns]"),
            "model_id": pd.Series(dtype=str),
            "sku": pd.Series(dtype=str),
            "location": pd.Series(dtype=str),
            "horizon": pd.Series(dtype=int),
            "y_true": pd.Series(dtype=float),
            "y_pred": pd.Series(dtype=float),
            "scored": pd.Series(dtype=bool),
            "exclusion_reason": pd.Series(dtype=object),
        }
    )


def plan_origins(n_weeks_usable: int, cfg, min_train_weeks: int = MIN_TRAIN_WEEKS) -> dict:
    """History gate + origin placement.

    Tier from config thresholds: n >= min_weeks_nested -> 'nested';
    n >= min_weeks_inner_only -> 'inner_only'; else 'none' (default to M5).

    Then walk origin-count targets down to minimums until
    ``weeks_needed = min_train + horizon + (sel + val) * step <= n``.
    Validation origins are shed first (selection stability matters more for
    picking; SPEC targets sel 8-12 vs val 4-8), then selection origins.
    If even the minimums do not fit, the tier degrades a level.

    Returns dict with tier, selection_origin_idx, validation_origin_idx
    (week indices into the panel, ascending, counted back from the end),
    plus the arithmetic (weeks_needed, counts, step, horizon).
    """
    scfg = _selection_cfg(cfg)
    n = int(n_weeks_usable)
    step = int(scfg.step_weeks)
    horizon = int(scfg.horizon_weeks)

    if n >= scfg.min_weeks_nested:
        tier = "nested"
    elif n >= scfg.min_weeks_inner_only:
        tier = "inner_only"
    else:
        tier = "none"

    def needed(sel: int, val: int) -> int:
        return min_train_weeks + horizon + (sel + val) * step

    def fit_counts(tier_: str) -> tuple[int, int] | None:
        sel = int(scfg.selection_origins_target)
        val = int(scfg.validation_origins_target) if tier_ == "nested" else 0
        val_min = int(scfg.validation_origins_minimum) if tier_ == "nested" else 0
        sel_min = int(scfg.selection_origins_minimum)
        while needed(sel, val) > n:
            if val > val_min:
                val -= 1
            elif sel > sel_min:
                sel -= 1
            else:
                return None
        return sel, val

    sel = val = 0
    while tier != "none":
        counts = fit_counts(tier)
        if counts is not None:
            sel, val = counts
            break
        tier = "inner_only" if tier == "nested" else "none"

    if tier == "none":
        return {
            "tier": "none",
            "selection_origin_idx": [],
            "validation_origin_idx": [],
            "selection_origins": 0,
            "validation_origins": 0,
            "weeks_needed": needed(scfg.selection_origins_minimum,
                                   scfg.validation_origins_minimum),
            "n_weeks_usable": n,
            "step_weeks": step,
            "horizon_weeks": horizon,
        }

    validation_origin_idx = [n - k * step for k in range(val, 0, -1)]
    selection_origin_idx = [n - k * step for k in range(sel + val, val, -1)]
    return {
        "tier": tier,
        "selection_origin_idx": selection_origin_idx,
        "validation_origin_idx": validation_origin_idx,
        "selection_origins": sel,
        "validation_origins": val,
        "weeks_needed": needed(sel, val),
        "n_weeks_usable": n,
        "step_weeks": step,
        "horizon_weeks": horizon,
    }


def run_backtest(
    mats: PanelMatrices,
    roster_factory: Callable[[], dict[str, BatchModel]],
    config,
    segments: pd.DataFrame | None = None,
    blocks: tuple[str, ...] = ("selection",),
    origin_plan: dict | None = None,
) -> BacktestResult:
    """Rolling origins, expanding window, fresh roster refit at every origin.

    For each origin j and horizon h: fit(Y_corrected[:, :j], usable[:, :j], j)
    then score prediction column h against Y_corrected[:, j+h-1]. The base
    class hard-asserts the prefix width, so a model can never see the origin
    week or beyond (future-blind guarantee).

    Rows are unscored with exclusion_reason:
      'censored'             target week is a High/Medium suspected stockout
      'unusable'             target week fails the usable mask (or NaN truth)
      'insufficient_history' model predicted NaN (below min_history_weeks)
      'beyond_panel'         target index past the panel end

    excluded_pct = share of censored rows among otherwise-scoreable rows
    (those that pass every other gate). Above config max_excluded_pct the
    selection result is too thin to trust (SPEC §10).
    """
    scfg = _selection_cfg(config)
    plan = origin_plan if origin_plan is not None else plan_origins(mats.n_weeks, scfg)
    horizon = int(scfg.horizon_weeks)
    horizons = list(range(1, horizon + 1))
    exclude_censored = bool(getattr(scfg, "exclude_censored_score_weeks", True))

    n = mats.n_series
    T = mats.n_weeks
    sku = mats.series_index["sku"].astype(str).to_numpy()
    loc = mats.series_index["location"].astype(str).to_numpy()

    frames: list[pd.DataFrame] = []
    origins_run: list[int] = []
    n_censored = 0
    n_otherwise_ok = 0

    for block in blocks:
        key = "selection_origin_idx" if block == "selection" else "validation_origin_idx"
        for origin_idx in plan.get(key, []):
            origin_idx = int(origin_idx)
            if origin_idx <= 0 or origin_idx > T:
                continue
            origins_run.append(origin_idx)
            origin_date = mats.weeks[origin_idx] if origin_idx < T else (
                mats.weeks[-1] + (mats.weeks[-1] - mats.weeks[-2] if T > 1 else pd.Timedelta(weeks=1))
            )
            Y_prefix = mats.Y_corrected[:, :origin_idx]
            usable_prefix = mats.usable_mask[:, :origin_idx]
            roster = roster_factory()   # fresh instances, refit every origin
            for model_id in sorted(roster):
                model = roster[model_id]
                model.fit(Y_prefix, usable_prefix, origin_idx)
                preds = np.asarray(model.predict(horizons), dtype=float)
                if preds.shape != (n, len(horizons)):
                    raise ValueError(
                        f"{model_id}: predict returned shape {preds.shape}, "
                        f"expected {(n, len(horizons))}"
                    )
                for j, h in enumerate(horizons):
                    t = origin_idx + h - 1
                    y_pred = preds[:, j]
                    insufficient = ~np.isfinite(y_pred)
                    if t >= T:
                        y_true = np.full(n, np.nan)
                        beyond = np.ones(n, dtype=bool)
                        censored = np.zeros(n, dtype=bool)
                        unusable = np.zeros(n, dtype=bool)
                    else:
                        y_true = mats.Y_corrected[:, t].astype(float)
                        beyond = np.zeros(n, dtype=bool)
                        censored = mats.stockout_mask[:, t] if exclude_censored else np.zeros(n, dtype=bool)
                        unusable = (~mats.usable_mask[:, t]) | ~np.isfinite(y_true)

                    otherwise_ok = ~(beyond | unusable | insufficient)
                    scored = otherwise_ok & ~censored
                    n_censored += int((censored & otherwise_ok).sum())
                    n_otherwise_ok += int(otherwise_ok.sum())

                    # precedence for the reported reason (least to most specific)
                    reason = np.full(n, None, dtype=object)
                    reason[insufficient] = "insufficient_history"
                    reason[unusable] = "unusable"
                    reason[censored] = "censored"
                    reason[beyond] = "beyond_panel"
                    reason[scored] = None

                    frames.append(pd.DataFrame({
                        "block": block,
                        "origin_date": origin_date,
                        "model_id": model_id,
                        "sku": sku,
                        "location": loc,
                        "horizon": h,
                        "y_true": y_true,
                        "y_pred": y_pred,
                        "scored": scored,
                        "exclusion_reason": reason,
                    }))

    scores = pd.concat(frames, ignore_index=True) if frames else empty_scores()
    excluded_pct = (100.0 * n_censored / n_otherwise_ok) if n_otherwise_ok else 0.0
    return BacktestResult(
        scores=scores,
        origins=origins_run,
        excluded_pct=float(excluded_pct),
        tier=str(plan.get("tier", "none")),
    )
