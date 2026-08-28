"""Stockout inference from zero-run analysis (SPEC §5).

For each SKU-location the trailing daily rate λ is estimated strictly
past-only (trailing 13-week mean of daily units via cumulative sums — the
value at day t uses days < t only, mirroring the clean/trailing.py
discipline; full-sample statistics are never used). Maximal zero-runs are
tested under a Poisson assumption using the λ in force at the run's *start*
(so the run itself cannot drag its own rate down).

**Multiple-testing correction — reinterprets ``zero_run_pvalue``.** The
spec's literal per-run rule (flag when exp(-λ·k) < 0.01) ignores that each
SKU is observed over hundreds of days: a λ=2.5/day SKU produces ~5 chance
2-day zero-runs (single-run p = e^-5 ≈ 0.0067) over 728 days, destroying
precision. The spec's own acceptance criteria (precision ≥ 85%, FP ≤ 5% on
intermittent items) take precedence over the literal formula, so the
detection criterion is an *expected-false-runs budget*: with
p_zero = exp(-λ), the expected number of chance maximal zero-runs of length
≥ k across the SKU's n_days observed days is approximately

    expected_runs(k) = n_days · (1 − p_zero) · p_zero^k

and a run is a candidate stockout only when
``expected_runs(k) < config.availability.zero_run_pvalue``. The existing
config key is reused as the false-run budget (default 0.01 ≈ a 1-in-100
chance of even one such run arising by chance on this SKU). Over two years
this flags k ≥ 4 at λ=3/day and requires k ≥ 11 at λ=1/day — which is what
kills the chance-run false positives. The high tier applies the stricter
budget ``zero_run_pvalue / 10``, mirroring the spec's 0.001 vs 0.01 ratio.
Episodes carry the expected-false-runs value in ``p_value`` (audit trail)
plus the raw single-run probability in ``single_run_p``.

Every candidate day is then cross-checked against the rest of the ACTIVE
catalogue (SKUs inside their first→last-sale span with trailing
λ ≥ 0.3/day): if most of the catalogue is also at zero the day is a closure /
holiday / feed outage, not a SKU-level stockout. Run-level share is the mean
of its day-level shares.

Confidence tiers (SPEC §5 table):

=============  =======================================================
high           λ ≥ 3/day, expected_runs < budget/10, cross-sectional < 20%
medium         λ ≥ 1/day, expected_runs < budget,    cross-sectional < 20%
low            threshold met but cross-sectional 20–60% (ambiguous)
not assessable λ < ``min_velocity_per_day`` — zero runs are normal
=============  =======================================================

Closure days (cross-sectional share > 60%) never become episodes and never
reduce ``in_stock_days`` — closures are non-selling days, not lost-sales
days. They are tagged internally on ``self.closure_days_`` for reporting.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from audit_engine.availability.base import AvailabilitySource
from audit_engine.schemas import StockoutSchema

# Trailing window for the daily-rate estimate: 13 weeks of days. Mirrors
# baseline.window_weeks but expressed in days; strictly past-only.
_LAMBDA_WINDOW_DAYS = 13 * 7

# SPEC §5 tier table. Tier boundaries, not tunables; not in defaults.yaml.
_HIGH_TIER_LAMBDA = 3.0
# High tier uses a false-run budget stricter by this factor (mirrors the
# spec's 0.001 vs 0.01 single-run p-value ratio).
_HIGH_TIER_BUDGET_RATIO = 10.0

# Minimum trailing daily rate for a SKU to count as part of the ACTIVE
# catalogue in the cross-sectional check (SPEC §5; not in defaults.yaml).
_ACTIVE_MIN_LAMBDA = 0.3

# Minimum days of prior history before a zero-run (or a week) is assessable.
# A trailing λ estimated from only a few days is dominated by the first-sale
# burst — on intermittent SKUs this inflates λ past the velocity gate and
# turns the normal post-launch quiet spell into a giant false "stockout"
# (observed on synthetic: every false positive started on spine day 1).
# Four weeks mirrors SPEC §6's launch rule ("< 4 weeks since launch → not
# assessable"); not in defaults.yaml.
_MIN_HISTORY_DAYS = 28

_WEEKDAYS = {
    "monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3,
    "friday": 4, "saturday": 5, "sunday": 6,
}

_TIER_RANK = {"": 0, "low": 1, "medium": 2, "high": 3}
_RANK_TIER = {1: "low", 2: "medium", 3: "high"}


def _trailing_lambda(units: np.ndarray, window: int = _LAMBDA_WINDOW_DAYS) -> np.ndarray:
    """Past-only trailing mean daily rate via cumulative sums.

    ``lam[t]`` is the mean of ``units[max(t-window, 0) : t]`` — never includes
    day t itself. ``lam[0]`` is NaN (no past). This intentionally mirrors the
    trailing/shifted discipline of clean/trailing.py (owned by another module)
    without importing rolling helpers for a plain cumulative-sum mean.
    """
    n = units.shape[0]
    csum = np.concatenate(([0.0], np.cumsum(units, dtype=float)))
    t = np.arange(n)
    lo = np.maximum(t - window, 0)
    span = (t - lo).astype(float)
    lam = np.full(n, np.nan)
    past = span > 0
    lam[past] = (csum[t[past]] - csum[lo[past]]) / span[past]
    return lam


def _empty_episodes() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "sku": pd.Series([], dtype=str),
            "location": pd.Series([], dtype=str),
            "start_date": pd.Series([], dtype="datetime64[ns]"),
            "end_date": pd.Series([], dtype="datetime64[ns]"),
            "days": pd.Series([], dtype=int),
            "confidence": pd.Series([], dtype=str),
            "p_value": pd.Series([], dtype=float),
            "cross_sectional_share": pd.Series([], dtype=float),
        }
    )


class InferredAvailability(AvailabilitySource):
    """v1 availability source: infer in-stock days from zero-run analysis."""

    def __init__(self) -> None:
        # Day-level closure tags (location, date) — days where the whole
        # catalogue went dark. Populated by in_stock_days(); internal only.
        self.closure_days_: pd.DataFrame | None = None

    def in_stock_days(self, daily: pd.DataFrame, config) -> tuple[pd.DataFrame, pd.DataFrame]:
        acfg = config.availability
        df = daily.loc[:, ["sku", "location", "date", "units"]].copy()
        df["date"] = pd.to_datetime(df["date"])
        df["units"] = pd.to_numeric(df["units"], errors="coerce").fillna(0.0)
        df = df.sort_values(["sku", "location", "date"], kind="mergesort").reset_index(drop=True)
        df["_day_idx"] = df.groupby(["sku", "location"]).cumcount()

        # --- (a) trailing past-only daily rate per SKU-location -------------
        lam = np.full(len(df), np.nan)
        for _, g in df.groupby(["sku", "location"], sort=False):
            pos = g.index.to_numpy()
            lam[pos] = _trailing_lambda(g["units"].to_numpy(dtype=float))
        df["lam"] = lam

        # --- active-catalogue membership for the cross-sectional check ------
        nz = df["units"] > 0
        spans = (
            df.loc[nz]
            .groupby(["sku", "location"])["date"]
            .agg(_first_sale="min", _last_sale="max")
            .reset_index()
        )
        df = df.merge(spans, on=["sku", "location"], how="left")
        df["_active"] = (
            (df["date"] >= df["_first_sale"])
            & (df["date"] <= df["_last_sale"])
            & (df["lam"] >= _ACTIVE_MIN_LAMBDA)
        )

        # --- (c) day-level cross-sectional zero share (per location) --------
        act = df.loc[df["_active"], ["location", "date", "units"]]
        share = (
            act.assign(_z=act["units"].eq(0))
            .groupby(["location", "date"])["_z"]
            .mean()
            .rename("cross_share")
            .reset_index()
        )
        df = df.merge(share, on=["location", "date"], how="left")
        df["cross_share"] = df["cross_share"].fillna(0.0)

        self.closure_days_ = (
            df.loc[df["cross_share"] > acfg.cross_sectional_closure_threshold, ["location", "date"]]
            .drop_duplicates()
            .reset_index(drop=True)
        )

        # --- (b) + (d) zero-run detection and tiering -----------------------
        stockout_tier = np.full(len(df), "", dtype=object)
        episodes: list[dict] = []
        for (sku, loc), g in df.groupby(["sku", "location"], sort=True):
            u = g["units"].to_numpy(dtype=float)
            g_lam = g["lam"].to_numpy(dtype=float)
            g_share = g["cross_share"].to_numpy(dtype=float)
            dates = g["date"].to_numpy()
            pos = g.index.to_numpy()
            n = len(u)
            i = 0
            while i < n:
                if u[i] != 0:
                    i += 1
                    continue
                j = i
                while j < n and u[j] == 0:
                    j += 1
                k = j - i
                lam0 = g_lam[i]  # rate in force at the run's start (past-only)
                # Applicability gates: (1) enough history for λ to be
                # trustworthy (launch-burst guard, see _MIN_HISTORY_DAYS);
                # (2) below min velocity zero runs are normal and inference
                # is worthless (SPEC §5) — no episode.
                if i >= _MIN_HISTORY_DAYS and not np.isnan(lam0) and lam0 >= acfg.min_velocity_per_day:
                    # Expected number of chance maximal zero-runs of length
                    # >= k over this SKU's n observed days (see module
                    # docstring — multiple-testing correction).
                    p_zero = float(np.exp(-lam0))
                    expected_runs = float(n * (1.0 - p_zero) * p_zero**k)
                    run_share = float(np.mean(g_share[i:j]))
                    if expected_runs < acfg.zero_run_pvalue:
                        if run_share > acfg.cross_sectional_closure_threshold:
                            # Closure / holiday / feed outage — not a stockout.
                            # No episode; day-level tags already collected.
                            pass
                        else:
                            if run_share < acfg.cross_sectional_ambiguous_threshold:
                                high_budget = acfg.zero_run_pvalue / _HIGH_TIER_BUDGET_RATIO
                                if lam0 >= _HIGH_TIER_LAMBDA and expected_runs < high_budget:
                                    conf = "high"
                                else:
                                    conf = "medium"
                            else:  # ambiguous cross-sectional band (20–60%)
                                conf = "low"
                            stockout_tier[pos[i:j]] = conf
                            episodes.append(
                                {
                                    "sku": sku,
                                    "location": loc,
                                    "start_date": pd.Timestamp(dates[i]),
                                    "end_date": pd.Timestamp(dates[j - 1]),
                                    "days": int(k),
                                    "confidence": conf,
                                    "p_value": expected_runs,
                                    "single_run_p": float(np.exp(-lam0 * k)),
                                    "cross_sectional_share": run_share,
                                }
                            )
                i = j
        df["_tier_rank"] = pd.Series(stockout_tier, index=df.index).map(_TIER_RANK)

        # --- (e) weekly aggregation ----------------------------------------
        wd = _WEEKDAYS.get(str(config.time.week_start).lower(), 0)
        df["week_start"] = df["date"] - pd.to_timedelta((df["date"].dt.weekday - wd) % 7, unit="D")
        weekly = (
            df.groupby(["sku", "location", "week_start"], sort=True)
            .agg(
                _out_days=("_tier_rank", lambda r: int((r > 0).sum())),
                _best=("_tier_rank", "max"),
                # positional first (pandas 'first' skips NaN; the week's opening
                # day may legitimately have an undefined rate)
                _lam_start=("lam", lambda s: s.iloc[0]),
                _idx_start=("_day_idx", "min"),
            )
            .reset_index()
        )
        weekly["in_stock_days"] = (7.0 - weekly["_out_days"]).clip(0.0, 7.0)

        def _confidence(row) -> str:
            if row["_out_days"] > 0:
                return _RANK_TIER[int(row["_best"])]
            if (
                row["_idx_start"] < _MIN_HISTORY_DAYS
                or np.isnan(row["_lam_start"])
                or row["_lam_start"] < acfg.min_velocity_per_day
            ):
                return "not_assessable"
            return "none"

        weekly["confidence"] = weekly.apply(_confidence, axis=1)
        weekly = weekly[["sku", "location", "week_start", "in_stock_days", "confidence"]]

        ep = pd.DataFrame(episodes) if episodes else _empty_episodes()
        ep = StockoutSchema.validate(ep)
        return weekly, ep
