"""Unit tests for availability/inferred.py (SPEC §5).

Detection uses the expected-false-runs criterion (see inferred.py docstring):
a zero-run of length k is a candidate only when
n_days * (1 - exp(-lam)) * exp(-lam)**k < zero_run_pvalue (the false-run
budget). High tier additionally requires lam >= 3 and the stricter budget/10.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from audit_engine.availability.inferred import InferredAvailability, _trailing_lambda
from audit_engine.config import Config

START = "2024-01-01"  # a Monday; day 91 is Monday 2024-04-01


def expected_runs(lam: float, k: int, n_days: int) -> float:
    """Expected chance maximal zero-runs of length >= k over n_days."""
    p_zero = np.exp(-lam)
    return n_days * (1.0 - p_zero) * p_zero**k


@pytest.fixture()
def cfg() -> Config:
    return Config()


def make_daily(series: dict[str, list[float]], start: str = START) -> pd.DataFrame:
    frames = []
    for sku, units in series.items():
        dates = pd.date_range(start, periods=len(units), freq="D")
        frames.append(
            pd.DataFrame({"sku": sku, "location": "ALL", "date": dates, "units": [float(u) for u in units]})
        )
    return pd.concat(frames, ignore_index=True)


def fillers(n_skus: int, n_days: int, rate: float = 2.0) -> dict[str, list[float]]:
    return {f"F{i:02d}": [rate] * n_days for i in range(n_skus)}


# --------------------------------------------------------------------------
# trailing lambda helper
# --------------------------------------------------------------------------

def test_trailing_lambda_is_past_only():
    u = np.array([3.0] * 10)
    lam = _trailing_lambda(u, window=91)
    assert np.isnan(lam[0])  # day 0 has no past
    assert np.allclose(lam[1:], 3.0)
    # value at t must not see day t: a spike today leaves today's lam unchanged
    u2 = u.copy()
    u2[5] = 1000.0
    lam2 = _trailing_lambda(u2, window=91)
    assert lam2[5] == lam[5]
    assert lam2[6] > lam[6]


def test_trailing_lambda_windowed():
    u = np.array([0.0] * 91 + [7.0] * 92)
    lam = _trailing_lambda(u, window=91)
    # at day 182 the window covers days 91..181 only -> the old zeros are gone
    assert lam[182] == pytest.approx(7.0)
    # at day 181 the window still contains one zero day (day 90)
    assert lam[181] == pytest.approx(90 * 7.0 / 91)


# --------------------------------------------------------------------------
# zero-run detection & tiers (expected-false-runs criterion)
# --------------------------------------------------------------------------

def test_six_day_run_on_fast_sku_is_high_tier(cfg):
    n = 105
    target = [3.0] * n
    target[91:97] = [0.0] * 6  # 2024-04-01 .. 2024-04-06
    daily = make_daily({"T": target, **fillers(10, n)})

    weekly, episodes = InferredAvailability().in_stock_days(daily, cfg)

    assert len(episodes) == 1
    ep = episodes.iloc[0]
    assert ep["sku"] == "T"
    assert ep["days"] == 6
    assert ep["confidence"] == "high"
    assert ep["start_date"] == pd.Timestamp("2024-04-01")
    assert ep["end_date"] == pd.Timestamp("2024-04-06")
    # lambda at run start is exactly 3 (constant history). p_value carries the
    # expected number of chance runs of length >= 6 over the SKU's 105 days
    assert ep["p_value"] == pytest.approx(expected_runs(3.0, 6, n), rel=1e-9)
    # audit trail keeps the raw single-run Poisson probability exp(-lam*k)
    assert ep["single_run_p"] == pytest.approx(np.exp(-3.0 * 6), rel=1e-9)
    # cross-sectional share: 1 zero SKU out of 11 active
    assert ep["cross_sectional_share"] == pytest.approx(1 / 11, rel=1e-9)

    # weekly arithmetic: the run sits entirely in the 2024-04-01 week
    wt = weekly[weekly["sku"] == "T"].set_index("week_start")
    assert wt.loc[pd.Timestamp("2024-04-01"), "in_stock_days"] == 1.0
    assert wt.loc[pd.Timestamp("2024-04-01"), "confidence"] == "high"
    other = wt.drop(index=pd.Timestamp("2024-04-01"))
    assert (other["in_stock_days"] == 7.0).all()


def test_one_day_run_not_flagged(cfg):
    n = 105
    target = [3.0] * n
    target[91] = 0.0
    daily = make_daily({"T": target, **fillers(10, n)})

    weekly, episodes = InferredAvailability().in_stock_days(daily, cfg)

    assert episodes.empty
    wt = weekly[weekly["sku"] == "T"]
    assert (wt["in_stock_days"] == 7.0).all()


def test_expected_runs_boundary_at_lambda_3(cfg):
    # lambda=3, n=105: expected_runs(3) ~ 0.0123 > 0.01 -> not flagged;
    # expected_runs(4) ~ 6.1e-4 < 0.001 -> flagged, and high tier
    n = 105
    assert expected_runs(3.0, 3, n) > cfg.availability.zero_run_pvalue
    assert expected_runs(3.0, 4, n) < cfg.availability.zero_run_pvalue / 10

    t3 = [3.0] * n
    t3[91:94] = [0.0] * 3
    _, ep3 = InferredAvailability().in_stock_days(make_daily({"T": t3, **fillers(10, n)}), cfg)
    assert ep3.empty

    t4 = [3.0] * n
    t4[91:95] = [0.0] * 4
    _, ep4 = InferredAvailability().in_stock_days(make_daily({"T": t4, **fillers(10, n)}), cfg)
    assert len(ep4) == 1
    assert ep4.iloc[0]["confidence"] == "high"
    assert ep4.iloc[0]["p_value"] == pytest.approx(expected_runs(3.0, 4, n), rel=1e-9)


def test_chance_runs_on_mid_velocity_sku_not_flagged(cfg):
    # Regression for the integration precision failure: lambda=2.5, k=2 has
    # single-run p = exp(-5) ~ 0.0067 < 0.01 (the literal spec rule fires),
    # but such runs occur several times per SKU by chance over long
    # histories. Expected-false-runs ~ 0.65 >> 0.01 -> must NOT be flagged.
    n = 105
    assert np.exp(-2.5 * 2) < cfg.availability.zero_run_pvalue  # old rule fired
    assert expected_runs(2.5, 2, n) > cfg.availability.zero_run_pvalue

    target = [2.5] * n
    target[91:93] = [0.0] * 2
    _, episodes = InferredAvailability().in_stock_days(make_daily({"T": target, **fillers(10, n)}), cfg)
    assert episodes.empty


def test_run_spanning_two_weeks_splits_in_stock_days(cfg):
    n = 112
    target = [3.0] * n
    target[95:101] = [0.0] * 6  # Fri 2024-04-05 .. Wed 2024-04-10
    daily = make_daily({"T": target, **fillers(10, n)})

    weekly, episodes = InferredAvailability().in_stock_days(daily, cfg)

    assert len(episodes) == 1
    assert episodes.iloc[0]["days"] == 6
    wt = weekly[weekly["sku"] == "T"].set_index("week_start")
    assert wt.loc[pd.Timestamp("2024-04-01"), "in_stock_days"] == 4.0  # Fri/Sat/Sun out
    assert wt.loc[pd.Timestamp("2024-04-08"), "in_stock_days"] == 4.0  # Mon/Tue/Wed out
    # total stockout days across weeks equals episode length
    assert (7.0 - wt["in_stock_days"]).sum() == 6.0


def test_medium_tier_when_lambda_between_1_and_3(cfg):
    # lambda=1.5, k=7: expected_runs ~ 2.2e-3 < 0.01 -> candidate; lambda < 3
    # -> medium tier
    n = 105
    assert expected_runs(1.5, 7, n) < cfg.availability.zero_run_pvalue
    target = [1.5] * n
    target[91:98] = [0.0] * 7
    daily = make_daily({"T": target, **fillers(10, n)})

    _, episodes = InferredAvailability().in_stock_days(daily, cfg)

    assert len(episodes) == 1
    ep = episodes.iloc[0]
    assert ep["confidence"] == "medium"
    assert ep["p_value"] == pytest.approx(expected_runs(1.5, 7, n), rel=1e-9)
    assert ep["single_run_p"] == pytest.approx(np.exp(-1.5 * 7), rel=1e-9)


# --------------------------------------------------------------------------
# cross-sectional check
# --------------------------------------------------------------------------

def test_catalogue_wide_zero_days_are_closure_not_stockout(cfg):
    n = 105
    series = {"T": [3.0] * n}
    for i in range(9):
        series[f"A{i}"] = [1.0] * n
    # days 91-94: target plus 6 of the 9 others at zero -> 7/10 = 70%
    for sku in ["T", "A0", "A1", "A2", "A3", "A4", "A5"]:
        for d in range(91, 95):
            series[sku][d] = 0.0
    daily = make_daily(series)

    avail = InferredAvailability()
    weekly, episodes = avail.in_stock_days(daily, cfg)

    # T's run (lambda=3, k=4) passes the false-run budget, but 70% > 60% -> closure
    assert episodes.empty
    # closures reduce in_stock_days for no one
    wt = weekly[weekly["sku"] == "T"]
    assert (wt["in_stock_days"] == 7.0).all()
    # the four days are tagged internally as closure days
    assert avail.closure_days_ is not None
    assert set(avail.closure_days_["date"]) == set(pd.date_range("2024-04-01", periods=4, freq="D"))


def test_ambiguous_cross_sectional_share_gives_low_tier(cfg):
    n = 105
    series = {"T": [3.0] * n}
    for i in range(9):
        series[f"A{i}"] = [1.0] * n
    # days 91-94: target plus 2 others at zero -> 3/10 = 30% (ambiguous band)
    for sku in ["T", "A0", "A1"]:
        for d in range(91, 95):
            series[sku][d] = 0.0
    daily = make_daily(series)

    _, episodes = InferredAvailability().in_stock_days(daily, cfg)

    # only T qualifies (A-SKUs: expected_runs(1.0, 4, 105) ~ 1.2 >> 0.01)
    assert len(episodes) == 1
    ep = episodes.iloc[0]
    assert ep["sku"] == "T"
    assert ep["confidence"] == "low"
    assert ep["cross_sectional_share"] == pytest.approx(0.3, rel=1e-9)


# --------------------------------------------------------------------------
# applicability gate
# --------------------------------------------------------------------------

def test_slow_sku_not_assessable(cfg):
    n = 105
    # ~0.5/day: sells 1 unit every other day, then a 10-day gap, then resumes
    slow = [1.0 if d % 2 == 0 else 0.0 for d in range(n)]
    slow[91:101] = [0.0] * 10
    slow[101:] = [1.0] * (n - 101)
    daily = make_daily({"S": slow, **fillers(2, n)})

    weekly, episodes = InferredAvailability().in_stock_days(daily, cfg)

    # lambda < min_velocity -> gated before any run statistics: no episode
    assert episodes.empty
    ws = weekly[weekly["sku"] == "S"]
    assert (ws["confidence"] == "not_assessable").all()
    assert (ws["in_stock_days"] == 7.0).all()
    # fast fillers are assessable once past the 28-day lambda warm-up
    warm = pd.Timestamp(START) + pd.Timedelta(days=28)
    wf = weekly[(weekly["sku"] == "F00") & (weekly["week_start"] >= warm)]
    assert (wf["confidence"] == "none").all()
    # ... and explicitly not assessable during the warm-up
    wf0 = weekly[(weekly["sku"] == "F00") & (weekly["week_start"] < warm)]
    assert (wf0["confidence"] == "not_assessable").all()


def test_launch_burst_quiet_spell_not_flagged(cfg):
    # Regression for the intermittent false-positive failure: a first-sale
    # burst (5 units on day 0) followed by a long quiet spell. Lambda at day 1
    # is estimated from a single day (5.0/day) and without the 28-day warm-up
    # gate the quiet spell becomes a giant false "stockout".
    n = 105
    target = [0.0] * n
    target[0] = 5.0
    for d in range(31, n, 3):  # then a slow drumbeat: 2 units every 3rd day
        target[d] = 2.0
    daily = make_daily({"T": target, **fillers(5, n)})

    _, episodes = InferredAvailability().in_stock_days(daily, cfg)

    assert episodes.empty


# --------------------------------------------------------------------------
# output hygiene
# --------------------------------------------------------------------------

def test_weekly_bounds_and_coverage(cfg):
    n = 105
    target = [3.0] * n
    target[91:97] = [0.0] * 6
    daily = make_daily({"T": target, **fillers(3, n)})

    weekly, _ = InferredAvailability().in_stock_days(daily, cfg)

    assert weekly["in_stock_days"].between(0, 7).all()
    # one row per SKU-week on the spine: 105 days = 15 weeks, 4 SKUs
    assert len(weekly) == 15 * 4
    assert set(weekly["confidence"]).issubset({"high", "medium", "low", "not_assessable", "none"})
