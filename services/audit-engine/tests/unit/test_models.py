"""Closed-form verifications for the model roster (agent E)."""
from __future__ import annotations

import numpy as np
import pytest

from audit_engine.config import Config
from audit_engine.models.base import BatchModel, FutureLeakError
from audit_engine.models.combos import (
    InverseErrorCombo,
    MeanCombo,
    MedianCombo,
    residual_correlation,
)
from audit_engine.models.ets import ETSDampedMult
from audit_engine.models.intermittent import TSB, CrostonSBA
from audit_engine.models.median import MedianWinsorized
from audit_engine.models.naive import MovingAverage, NaiveDrift, NaiveLast, NaiveSeasonal
from audit_engine.models.registry import build_roster
from audit_engine.models.smoothing import SES, Theta


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


# ---------------------------------------------------------------- M1


def test_naive_last_exact():
    m = fit(NaiveLast(), [[1, 2, 3], [np.nan, np.nan, np.nan]])
    pred = m.predict([1, 2])
    assert np.array_equal(pred[0], [3.0, 3.0])
    assert np.isnan(pred[1]).all()  # no usable history -> NaN


def test_naive_last_respects_usable_mask():
    m = fit(NaiveLast(), [[1, 2, 3]], usable=[[True, True, False]])
    assert m.predict([1])[0, 0] == 2.0  # masked final week skipped


# ---------------------------------------------------------------- M2


def test_naive_seasonal_exact_lag_52():
    y = list(range(104))  # y[t] = t
    m = fit(NaiveSeasonal(), [y])
    pred = m.predict([1, 2, 3, 4])
    # target week 104+h-1 reads column 104+h-1-52
    assert np.array_equal(pred[0], [52.0, 53.0, 54.0, 55.0])


def test_naive_seasonal_below_52w_is_nan():
    y = [np.nan] * 64 + list(range(40))  # only 40 usable weeks
    m = fit(NaiveSeasonal(), [y])
    assert np.isnan(m.predict([1, 4])).all()


# ---------------------------------------------------------------- M3


def test_naive_drift_exact_on_linear():
    y = [10 + 2 * t for t in range(10)]  # last=28, mean diff=2
    m = fit(NaiveDrift(), [y])
    assert np.allclose(m.predict([1, 3])[0], [30.0, 34.0])


def test_naive_drift_skips_nan_gaps():
    y = [10, np.nan, 14, 16, 18, 20, 22, 24, 26]  # 8 usable values
    m = fit(NaiveDrift(), [y])
    drift = (26 - 10) / 7  # mean first-difference of compressed history
    assert np.allclose(m.predict([1])[0, 0], 26 + drift)


# ---------------------------------------------------------------- M4


def test_moving_average_exact():
    m = fit(MovingAverage(4), [[1, 2, 3, 4, 5, 6]])
    assert m.predict([1, 2])[0, 0] == pytest.approx(np.mean([3, 4, 5, 6]))
    assert m.model_id == "M4_4"


def test_moving_average_skips_nan_and_min_history():
    y = [1, 2, np.nan, 4, 5, 6, 7]
    m = fit(MovingAverage(4), [y])
    assert m.predict([1])[0, 0] == pytest.approx(np.mean([4, 5, 6, 7]))
    m8 = fit(MovingAverage(8), [[1, 2, 3, 4, 5, 6]])  # 6 < 8 usable weeks
    assert np.isnan(m8.predict([1])).all()


# ---------------------------------------------------------------- M5


def test_median_winsorized_robust_to_positive_spike():
    y = [10.0] * 12 + [100.0]  # spike in the window
    m = fit(MedianWinsorized(), [y])
    assert m.predict([1])[0, 0] == pytest.approx(10.0)


def test_median_winsorized_cap_changes_the_median():
    # Median of the raw window is (-5+3)/2 = -1 -> cap = -2; capping pulls
    # 3, 10, 10 down to -2, so the winsorized median moves to (-5 + -2)/2.
    y = [-5.0, -5.0, -5.0, 3.0, 10.0, 10.0]
    m = fit(MedianWinsorized(), [y])
    raw_median = np.median(y)
    pred = m.predict([1])[0, 0]
    assert pred == pytest.approx(-3.5)
    assert pred != pytest.approx(raw_median)


def test_median_winsorized_min_history_nan():
    m = fit(MedianWinsorized(), [[5.0, 5.0, 5.0]])  # 3 < 6 usable weeks
    assert np.isnan(m.predict([1])).all()


# ---------------------------------------------------------------- M6


def test_ses_recursion_matches_hand_computation():
    y = [10, 12, 11, 13, 12, 14, 13, 15]
    alpha = 0.3
    level = y[0]
    for v in y[1:]:
        level = level + alpha * (v - level)
    m = fit(SES(alpha_bounds=(0.3, 0.3)), [y])  # degenerate grid pins alpha
    assert m.predict([1, 4])[0, 0] == pytest.approx(level)
    assert m.alpha_[0] == pytest.approx(0.3)


def test_ses_alpha_within_clamp_bounds():
    rng = np.random.default_rng(0)
    rows = rng.gamma(2.0, 5.0, size=(20, 30))
    m = SES(alpha_bounds=(0.05, 0.40))
    m.fit(rows, np.ones_like(rows, dtype=bool), rows.shape[1])
    assert np.all(m.alpha_ >= 0.05 - 1e-12)
    assert np.all(m.alpha_ <= 0.40 + 1e-12)


def test_ses_min_history_nan():
    m = fit(SES(), [[1, 2, 3, 4, 5]])  # 5 < 8
    assert np.isnan(m.predict([1])).all()


# ---------------------------------------------------------------- M7


def test_theta_continues_linear_trend():
    slope, intercept, n = 0.5, 100.0, 52
    y = [intercept + slope * t for t in range(n)]
    m = fit(Theta(), [y])
    pred = m.predict([1, 2, 3, 4])[0]
    truth = np.array([intercept + slope * (n - 1 + h) for h in [1, 2, 3, 4]])
    assert np.all(np.abs(pred - truth) / truth < 0.05)
    assert np.all(np.diff(pred) > 0)  # trend direction preserved


# ---------------------------------------------------------------- M8


def test_croston_sba_hand_computed():
    y = [0, 2, 0, 0, 3, 0, 0, 0, 6, 0, 0, 3, 0]  # 13 weeks
    # Hand recursion, alpha=0.1 (intervals in usable periods):
    # t1: init z=2, p=2 | t4 (q=3): z=2.1, p=2.1 | t8 (q=4): z=2.49, p=2.29
    # t11 (q=3): z=2.541, p=2.361
    z, p = 2.541, 2.361
    expected = (z / p) * (1 - 0.1 / 2)
    m = fit(CrostonSBA(alpha=0.1), [y])
    assert m.predict([1, 3])[0, 0] == pytest.approx(expected)
    assert m.handles_intermittent


# ---------------------------------------------------------------- M9


def test_tsb_decays_on_dying_series_while_sba_does_not():
    y = [2.0] * 20 + [0.0] * 30  # item stops selling
    m9 = fit(TSB(), [y])
    m8 = fit(CrostonSBA(), [y])
    p9 = m9.predict([1])[0, 0]
    p8 = m8.predict([1])[0, 0]
    # TSB: p decays 1.0 * 0.9^30 = 0.0424 -> forecast ~0.085
    assert p9 < 0.1
    assert p9 == pytest.approx(1.0 * 0.9**30 * 2.0)
    # SBA never updates after the last demand: stays at ~last size/interval
    assert p8 > 1.5
    assert p8 == pytest.approx(2.0 * (1 - 0.05))


def test_tsb_all_zero_series_forecasts_zero():
    m = fit(TSB(), [[0.0] * 20])
    assert m.predict([1])[0, 0] == 0.0


# ---------------------------------------------------------------- future-blind / min-history


def test_future_leak_error_on_wide_prefix():
    Y = np.ones((2, 5))
    U = np.ones_like(Y, dtype=bool)
    with pytest.raises(FutureLeakError):
        NaiveLast().fit(Y, U, origin_idx=4)  # prefix wider than origin


def test_min_history_rule_generic():
    y = [[np.nan] * 10 + [1.0, 2.0, 3.0]]  # 3 usable weeks
    for model in [NaiveDrift(), SES(), Theta(), CrostonSBA(), TSB()]:
        m = fit(model, y)
        assert np.isnan(m.predict([1, 2])).all(), model.model_id


# ---------------------------------------------------------------- combos


class _Stub(BatchModel):
    """Fixed-output member for combo tests."""

    min_history_weeks = 1

    def __init__(self, model_id, values):
        super().__init__()
        self.model_id = model_id
        self.values = np.asarray(values, dtype=float)

    def _fit(self, Y_prefix, usable_prefix, origin_idx):
        self.saw_origin = origin_idx

    def _predict(self, horizons):
        return np.tile(self.values[:, None], (1, len(horizons)))


def _stub_trio():
    # 2 series; member B predicts NaN for series 1
    a = _Stub("A", [1.0, 4.0])
    b = _Stub("B", [2.0, np.nan])
    c = _Stub("C", [10.0, 8.0])
    return [a, b, c]


def test_median_combo_and_nan_member_ignored():
    members = _stub_trio()
    combo = MedianCombo(members)
    Y, U, o = mk([[1.0] * 4, [1.0] * 4])
    combo.fit(Y, U, o)
    assert all(m.saw_origin == o for m in members)  # members fitted on same args
    pred = combo.predict([1, 2])
    assert np.array_equal(pred[0], [2.0, 2.0])  # median(1, 2, 10)
    assert np.array_equal(pred[1], [6.0, 6.0])  # NaN member ignored: median(4, 8)


def test_mean_combo_nan_aware():
    combo = MeanCombo(_stub_trio())
    Y, U, o = mk([[1.0] * 4, [1.0] * 4])
    combo.fit(Y, U, o)
    pred = combo.predict([1])
    assert pred[0, 0] == pytest.approx(np.mean([1, 2, 10]))
    assert pred[1, 0] == pytest.approx(np.mean([4, 8]))


def test_inverse_error_combo_floor_and_renormalize():
    members = _stub_trio()
    combo = InverseErrorCombo(members, weights=np.array([0.7, 0.25, 0.05]), floor=0.10)
    # floor lifts 0.05 -> 0.10, then renormalize by 1.05
    assert np.allclose(combo.weights, np.array([0.7, 0.25, 0.10]) / 1.05)
    assert combo.weights.sum() == pytest.approx(1.0)
    Y, U, o = mk([[1.0] * 4, [1.0] * 4])
    combo.fit(Y, U, o)
    pred = combo.predict([1])
    assert pred[0, 0] == pytest.approx((0.7 * 1 + 0.25 * 2 + 0.10 * 10) / 1.05)
    # NaN member dropped, surviving weights renormalize
    assert pred[1, 0] == pytest.approx((0.7 * 4 + 0.10 * 8) / 0.8)


def test_residual_correlation():
    errs = {
        "M5": np.array([1.0, 2.0, 3.0, 4.0]),
        "M7": np.array([2.0, 4.0, 6.0, 8.0]),
        "M9": np.array([-1.0, -2.0, -3.0, np.nan]),
    }
    corr = residual_correlation(errs)
    assert list(corr.index) == ["M5", "M7", "M9"]
    assert corr.loc["M5", "M7"] == pytest.approx(1.0)
    assert corr.loc["M5", "M9"] == pytest.approx(-1.0)  # NaN pair excluded
    assert corr.loc["M5", "M5"] == pytest.approx(1.0)


# ---------------------------------------------------------------- registry


def test_registry_builds_full_default_roster():
    cfg = Config()
    roster = build_roster(cfg)
    assert set(roster) == {
        "M1", "M2", "M3", "M4_4", "M4_8", "M4_13", "M5", "M6", "M7", "M8", "M9", "M10",
    }
    for model_id, model in roster.items():
        assert isinstance(model, BatchModel)
        assert model.model_id == model_id
    assert roster["M4_8"].n == 8
    assert roster["M4_13"].n == 13
    assert roster["M2"].min_history_weeks == cfg.models.seasonal_naive_min_weeks
    assert roster["M10"].min_history_weeks == cfg.models.ets_min_weeks
    assert roster["M5"].window == cfg.baseline.window_weeks
    # fresh instances on every call
    again = build_roster(cfg)
    assert all(again[k] is not roster[k] for k in roster)


def test_registry_unknown_id_raises():
    cfg = Config()
    cfg.models.roster = ["M1", "M99"]
    with pytest.raises(KeyError):
        build_roster(cfg)
    cfg.models.roster = ["M4_x"]
    with pytest.raises(KeyError):
        build_roster(cfg)


# ---------------------------------------------------------------- M10 smoke


def test_ets_smoke_seasonal_fit_fallback_and_gate():
    rng = np.random.default_rng(7)
    t = np.arange(104)
    seasonal = 50 + 20 * np.sin(2 * np.pi * t / 52)
    row_ok = seasonal + rng.normal(0, 0.5, size=104)  # strictly positive
    assert row_ok.min() > 0
    row_zero = seasonal.copy()
    row_zero[10] = 0.0  # fails strict positivity -> M5 fallback
    row_short = np.full(104, np.nan)
    row_short[-50:] = 5.0  # below the 104w gate -> NaN
    Y = np.vstack([row_ok, row_zero, row_short])
    U = np.ones_like(Y, dtype=bool)

    m = ETSDampedMult(min_history_weeks=104, n_jobs=1)
    m.fit(Y, U, Y.shape[1])
    pred = m.predict([1, 2, 3, 4])

    # gated series: finite, in a sane range around the seasonal curve
    assert np.all(np.isfinite(pred[0]))
    assert np.all(pred[0] > 10) and np.all(pred[0] < 110)
    # fallback series equals M5 (fitted internally on the same prefix)
    m5 = MedianWinsorized()
    m5.fit(Y, U, Y.shape[1])
    assert np.allclose(pred[1], m5.predict([1, 2, 3, 4])[1])
    assert m.fallback_count == 1
    # below-gate series stays NaN
    assert np.isnan(pred[2]).all()
