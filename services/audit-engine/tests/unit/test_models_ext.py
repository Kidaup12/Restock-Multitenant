"""Closed-form and smoke checks for the M13-M22 extension roster."""
from __future__ import annotations

import numpy as np
import pytest

from audit_engine.config import Config
from audit_engine.models.base import BatchModel
from audit_engine.models.broad import (
    DampedHolt,
    Holt,
    RecencyPoissonRate,
    TrimmedMean,
    WeightedMA,
)
from audit_engine.models.intermittent_ext import (
    ADIDA,
    CrostonOriginal,
    CrostonSBAOpt,
    TSBOpt,
    ZeroForecast,
)
from audit_engine.models.registry import build_roster


def mk(rows):
    """(Y, usable, origin_idx) from a list of per-series value lists (NaN ok)."""
    Y = np.asarray(rows, dtype=float)
    return Y, np.ones_like(Y, dtype=bool), Y.shape[1]


def fit(model, rows, usable=None):
    Y, U, o = mk(rows)
    if usable is not None:
        U = np.asarray(usable, dtype=bool)
    model.fit(Y, U, o)
    return model


# A shared 8-series x 30-week NaN-holed panel for the shape smoke tests.
def _holed_panel(seed=0):
    rng = np.random.default_rng(seed)
    Y = rng.poisson(1.5, size=(8, 30)).astype(float)
    # Hole out the first weeks of some series (out-of-lifespan) and a few gaps.
    Y[0, :10] = np.nan
    Y[3, :5] = np.nan
    Y[5, 12] = np.nan
    Y[7, :20] = np.nan  # only 10 usable weeks -> below several min_history gates
    U = np.ones_like(Y, dtype=bool)
    U[2, 7] = False  # a masked-unusable cell
    return Y, U, Y.shape[1]


ALL_MODELS = [
    CrostonOriginal,
    CrostonSBAOpt,
    TSBOpt,
    ADIDA,
    ZeroForecast,
    Holt,
    DampedHolt,
    WeightedMA,
    TrimmedMean,
    RecencyPoissonRate,
]


@pytest.mark.parametrize("cls", ALL_MODELS)
def test_fits_and_predicts_correct_shape_on_holed_panel(cls):
    Y, U, o = _holed_panel()
    m = cls()
    m.fit(Y, U, o)
    horizons = [1, 2, 3, 4]
    pred = m.predict(horizons)
    assert pred.shape == (8, len(horizons))
    # No infs; NaN only (predictions are floored non-negative where finite).
    finite = np.isfinite(pred)
    assert np.all(pred[finite] >= 0.0)
    assert not np.isinf(pred).any()


# ---------------------------------------------------------------- M17 ZeroForecast


def test_zero_forecast_always_zero():
    Y, U, o = _holed_panel()
    m = ZeroForecast()
    m.fit(Y, U, o)
    pred = m.predict([1, 2, 3])
    # min_history_weeks=1 so every series here has enough -> all exactly 0.
    assert np.all(pred == 0.0)


def test_zero_forecast_nan_below_min_history():
    # A fully-NaN series has zero usable weeks (< 1) -> NaN.
    m = fit(ZeroForecast(), [[np.nan] * 20, [1.0] * 20])
    pred = m.predict([1])
    assert np.isnan(pred[0, 0])
    assert pred[1, 0] == 0.0


# ---------------------------------------------------------------- M13 CrostonOriginal


def test_croston_original_regular_demand_recovers_one_per_week():
    # Every 3rd week a demand of size 3 -> rate 3/3 = 1.0 per week.
    y = [0.0, 0.0, 3.0] * 10  # 30 weeks, size-3 demand every 3rd week
    m = fit(CrostonOriginal(), [y])
    pred = m.predict([1, 4])[0, 0]
    assert pred == pytest.approx(1.0, abs=0.05)


def test_croston_original_no_bias_correction_vs_sba():
    from audit_engine.models.intermittent import CrostonSBA

    y = [0, 2, 0, 0, 3, 0, 0, 0, 6, 0, 0, 3, 0]  # 13 weeks
    orig = fit(CrostonOriginal(alpha=0.1), [y]).predict([1])[0, 0]
    sba = fit(CrostonSBA(alpha=0.1), [y]).predict([1])[0, 0]
    # Original = z/p; SBA = (z/p)*(1 - alpha/2), strictly smaller.
    assert orig == pytest.approx(sba / (1 - 0.05))


# ---------------------------------------------------------------- M16 ADIDA


def test_adida_regular_demand_recovers_one_per_week():
    y = [0.0, 0.0, 3.0] * 10  # rate ~1.0/week, mean interval 3
    m = fit(ADIDA(), [y])
    pred = m.predict([1, 3])[0, 0]
    assert pred == pytest.approx(1.0, abs=0.1)


def test_adida_block_size_clamped():
    # Very sparse -> mean interval large, block clamps to 8.
    y = [0.0] * 8 + [8.0] + [0.0] * 8 + [8.0] + [0.0] * 8 + [8.0] + [0.0] * 4
    m = fit(ADIDA(), [y])
    pred = m.predict([1])[0, 0]
    assert np.isfinite(pred) and pred >= 0.0


# ---------------------------------------------------------------- M14 / M15 opt


def test_croston_sba_opt_fits_alpha_in_bounds():
    rng = np.random.default_rng(1)
    Y = (rng.random((10, 40)) < 0.3) * rng.integers(1, 5, size=(10, 40))
    m = CrostonSBAOpt(alpha_bounds=(0.05, 0.40))
    m.fit(Y.astype(float), np.ones_like(Y, dtype=bool), Y.shape[1])
    a = m.alpha_[np.isfinite(m.alpha_)]
    assert np.all(a >= 0.05 - 1e-9) and np.all(a <= 0.40 + 1e-9)


def test_tsb_opt_fits_alphas_in_grid_and_forecasts_nonneg():
    rng = np.random.default_rng(2)
    Y = (rng.random((10, 40)) < 0.3) * rng.integers(1, 5, size=(10, 40))
    m = TSBOpt(grid=(0.05, 0.30), n_grid=3)
    m.fit(Y.astype(float), np.ones_like(Y, dtype=bool), Y.shape[1])
    ap = m.alpha_p_[np.isfinite(m.alpha_p_)]
    az = m.alpha_z_[np.isfinite(m.alpha_z_)]
    grid = {0.05, 0.175, 0.30}
    assert all(round(float(x), 6) in {round(g, 6) for g in grid} for x in ap)
    assert all(round(float(x), 6) in {round(g, 6) for g in grid} for x in az)
    pred = m.predict([1])
    assert np.all(pred[np.isfinite(pred)] >= 0.0)


# ---------------------------------------------------------------- M18 Holt


def test_holt_recovers_clean_linear_trend():
    slope, intercept, n = 2.0, 5.0, 30
    y = [intercept + slope * t for t in range(n)]
    m = fit(Holt(), [y])
    pred = m.predict([1, 2, 3, 4])[0]
    truth = np.array([intercept + slope * (n - 1 + h) for h in [1, 2, 3, 4]])
    assert np.all(np.abs(pred - truth) / truth < 0.10)


def test_holt_floors_at_zero():
    y = [20 - 1.5 * t for t in range(20)]  # trends negative
    m = fit(Holt(), [y])
    pred = m.predict([1, 2, 3, 4])[0]
    assert np.all(pred >= 0.0)


# ---------------------------------------------------------------- M19 DampedHolt


def test_damped_holt_below_holt_on_upward_trend_at_h4():
    slope, n = 2.0, 30
    y = [5.0 + slope * t for t in range(n)]
    holt = fit(Holt(), [y]).predict([1, 2, 3, 4])[0]
    damped = fit(DampedHolt(), [y]).predict([1, 2, 3, 4])[0]
    assert damped[3] < holt[3]  # damping flattens the extrapolation at h=4


# ---------------------------------------------------------------- M20 WeightedMA


def test_weighted_ma_weights_recent_higher():
    # Flat then a jump at the end: a recency-weighted MA sits above the flat
    # mean of the window because the newest (high) value carries more weight.
    y = [1.0] * 7 + [9.0]  # window of 8; newest is the 9
    m = fit(WeightedMA(n=8), [y])
    pred = m.predict([1])[0, 0]
    flat_mean = np.mean(y)  # 2.0
    assert pred > flat_mean
    # Exact linear-weight check: weights 1..8, values [1]*7 + [9].
    w = np.arange(1, 9, dtype=float)
    expected = (w[:7] @ np.ones(7) + w[7] * 9) / w.sum()
    assert pred == pytest.approx(expected)


# ---------------------------------------------------------------- M21 TrimmedMean


def test_trimmed_mean_drops_a_spike():
    # 12 steady 5s plus one 100 spike over a 13-week window: trimming the
    # single max (and single min, a 5) yields a mean of exactly 5.
    y = [5.0] * 12 + [100.0]
    m = fit(TrimmedMean(window=13), [y])
    pred = m.predict([1])[0, 0]
    assert pred == pytest.approx(5.0)
    # Compare to plain mean, which the spike drags well above 5.
    assert np.mean(y) > 10.0


# ---------------------------------------------------------------- M22 recency-Poisson


def test_recency_poisson_recovers_steady_rate():
    y = [2.0] * 20  # steady rate 2
    m = fit(RecencyPoissonRate(), [y])
    assert m.predict([1, 4])[0, 0] == pytest.approx(2.0)


def test_recency_poisson_robust_to_zeros():
    # Mean of a zero-heavy series is a valid rate; must be finite and >= 0.
    y = [0.0, 0.0, 3.0, 0.0, 0.0, 2.0, 0.0, 0.0, 1.0, 0.0]
    m = fit(RecencyPoissonRate(), [y])
    pred = m.predict([1])[0, 0]
    assert np.isfinite(pred) and pred >= 0.0


def test_recency_poisson_weights_recent_higher():
    # Rising series: recency-weighted mean exceeds the flat mean.
    y = [float(t) for t in range(16)]
    m = fit(RecencyPoissonRate(half_life=8.0), [y])
    pred = m.predict([1])[0, 0]
    assert pred > np.mean(y)


# ---------------------------------------------------------------- min-history


def test_min_history_returns_nan_for_all_new_models():
    # 3 usable weeks: below every extension model's min_history except M17
    # (WeightedMA min=4 is the lowest gate among the rest).
    y = [[np.nan] * 25 + [1.0, 2.0, 3.0]]
    for cls in ALL_MODELS:
        if cls is ZeroForecast:
            continue  # min_history=1, so 3 usable weeks is sufficient
        m = fit(cls(), y)
        pred = m.predict([1, 2])
        assert np.isnan(pred).all(), cls.__name__


# ---------------------------------------------------------------- registry


def test_registry_builds_extension_ids():
    cfg = Config()
    cfg.models.roster = [f"M{i}" for i in range(13, 23)]
    roster = build_roster(cfg)
    assert set(roster) == {f"M{i}" for i in range(13, 23)}
    for model_id, model in roster.items():
        assert isinstance(model, BatchModel)
        assert model.model_id == model_id
    # intermittent flags
    assert roster["M13"].handles_intermittent
    assert roster["M17"].handles_intermittent
    assert roster["M17"].min_history_weeks == 1
    assert roster["M22"].handles_intermittent
    assert not roster["M18"].handles_intermittent
