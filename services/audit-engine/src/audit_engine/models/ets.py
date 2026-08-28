"""M10 ets_damped_mult — statsmodels ETS(A, Ad, M), the ONE permitted
per-series model.

Gating: a series is fitted with ETS only when it has >= min_history_weeks
(config.models.ets_min_weeks, default 104) usable non-NaN weeks AND all its
usable values are strictly positive (a hard requirement of multiplicative
seasonality). Gated series are fitted in parallel with
joblib.Parallel(n_jobs=-2) on their compressed (NaN-free) usable history.

Fallbacks: any exception, non-convergence, or non-finite forecast — and any
series that clears the week gate but fails strict positivity — falls back to
M5's (median_winsorized) prediction for that series; the number of fallbacks
is recorded on the instance as ``.fallback_count``. Series below the week
gate predict NaN per the min-history rule.
"""
from __future__ import annotations

import warnings

import numpy as np
import pandas as pd
from joblib import Parallel, delayed

from .base import BatchModel, insufficient_history, masked_history
from .median import MedianWinsorized
from .smoothing import compress


def _fit_forecast_one(y: np.ndarray, seasonal_periods: int, hmax: int) -> np.ndarray | None:
    """Fit ETS(A, Ad, M) on one compressed series; return hmax-step forecast
    or None on any failure (caught -> M5 fallback)."""
    try:
        from statsmodels.tsa.exponential_smoothing.ets import ETSModel

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            model = ETSModel(
                pd.Series(np.asarray(y, dtype=float)),
                error="add",
                trend="add",
                damped_trend=True,
                seasonal="mul",
                seasonal_periods=seasonal_periods,
            )
            res = model.fit(disp=False)
            fc = np.asarray(res.forecast(hmax), dtype=float)
        if fc.shape != (hmax,) or not np.all(np.isfinite(fc)):
            return None
        return fc
    except Exception:
        return None


class ETSDampedMult(BatchModel):
    """M10 — additive error, damped additive trend, multiplicative seasonality."""

    model_id = "M10"

    def __init__(
        self,
        min_history_weeks: int = 104,
        seasonal_periods: int = 52,
        n_jobs: int = -2,
    ) -> None:
        super().__init__()
        self.min_history_weeks = int(min_history_weeks)
        self.seasonal_periods = int(seasonal_periods)
        self.n_jobs = int(n_jobs)
        self.fallback_count: int = 0

    def _fit(self, Y_prefix: np.ndarray, usable_prefix: np.ndarray, origin_idx: int) -> None:
        H = masked_history(Y_prefix, usable_prefix)
        self._H = H
        self._insuff = insufficient_history(Y_prefix, usable_prefix, self.min_history_weeks)
        valid = ~np.isnan(H)
        # Strict positivity over the usable values (required for 'mul' seasonality).
        self._positive = np.where(valid, H, np.inf).min(axis=1) > 0
        # Internal M5 fitted on the same prefix — the fallback prediction source.
        self._m5 = MedianWinsorized()
        self._m5.fit(Y_prefix, usable_prefix, origin_idx)
        # Lazy ETS cache: computed at predict time for the needed max horizon.
        self._ets_fc: np.ndarray | None = None
        self._fallback_rows: np.ndarray | None = None
        self.fallback_count = 0

    def _run_ets(self, hmax: int) -> None:
        n = self._H.shape[0]
        gated = ~self._insuff & self._positive
        rows = np.nonzero(gated)[0]
        C = compress(self._H)
        series = [C[i][~np.isnan(C[i])] for i in rows]  # per-series extraction, permitted here
        if len(series):
            results = Parallel(n_jobs=self.n_jobs)(
                delayed(_fit_forecast_one)(y, self.seasonal_periods, hmax) for y in series
            )
        else:
            results = []
        fc = np.full((n, hmax), np.nan)
        fallback = ~self._insuff & ~self._positive  # week-gated but not strictly positive
        for i, res in zip(rows, results):
            if res is None:
                fallback[i] = True
            else:
                fc[i, :] = res
        self._ets_fc = fc
        self._fallback_rows = fallback
        self.fallback_count = int(fallback.sum())

    def _predict(self, horizons: list[int]) -> np.ndarray:
        hmax = max(horizons)
        if self._ets_fc is None or self._ets_fc.shape[1] < hmax:
            self._run_ets(hmax)
        n = self._H.shape[0]
        out = np.full((n, len(horizons)), np.nan)
        for j, h in enumerate(horizons):
            out[:, j] = self._ets_fc[:, h - 1]
        m5_pred = self._m5.predict(horizons)
        fb = self._fallback_rows
        out[fb, :] = m5_pred[fb, :]
        out[self._insuff, :] = np.nan
        return out
