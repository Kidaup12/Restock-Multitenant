"""M8 Croston-SBA and M9 TSB — intermittent-demand models.

Vectorized: the recursions loop over weeks; all state is per-series numpy
arrays. NaN cells (unusable weeks) are skipped entirely — they advance
neither intervals nor probabilities, matching the "treat as missing, not
zero" contract in base.py.

Demand period = usable week with value > 0. Series with sufficient history
but no positive demand at all forecast 0.0 (a dead item, not missing data).
"""
from __future__ import annotations

import numpy as np

from .base import BatchModel, insufficient_history, masked_history
from .naive import _flat


class CrostonSBA(BatchModel):
    """M8 — Croston's method with the Syntetos-Boylan bias correction.

    alpha (default 0.1) smooths both demand sizes z and inter-demand
    intervals p (measured in usable periods). Initialization: first demand
    sets z = its size, p = periods elapsed from the start of usable history.
    Forecast = (z / p) * (1 - alpha / 2), flat across horizons.
    """

    model_id = "M8"
    min_history_weeks = 13
    handles_intermittent = True

    def __init__(self, alpha: float = 0.1) -> None:
        super().__init__()
        self.alpha = float(alpha)

    def _fit(self, Y_prefix: np.ndarray, usable_prefix: np.ndarray, origin_idx: int) -> None:
        H = masked_history(Y_prefix, usable_prefix)
        n, T = H.shape
        a = self.alpha
        z = np.full(n, np.nan)
        p = np.full(n, np.nan)
        q = np.zeros(n)  # usable periods since last demand
        has_demand = np.zeros(n, dtype=bool)
        for t in range(T):
            y = H[:, t]
            valid = ~np.isnan(y)
            q[valid] += 1.0
            dem = valid & (y > 0)
            first = dem & ~has_demand
            if first.any():
                z[first] = y[first]
                p[first] = q[first]
            upd = dem & has_demand
            if upd.any():
                z[upd] += a * (y[upd] - z[upd])
                p[upd] += a * (q[upd] - p[upd])
            has_demand |= dem
            q[dem] = 0.0
        with np.errstate(divide="ignore", invalid="ignore"):
            pred = np.where(has_demand, (z / p) * (1.0 - a / 2.0), 0.0)
        pred[insufficient_history(Y_prefix, usable_prefix, self.min_history_weeks)] = np.nan
        self._pred = pred

    def _predict(self, horizons: list[int]) -> np.ndarray:
        return _flat(self._pred, horizons)


class TSB(BatchModel):
    """M9 — Teunter-Syntetos-Babai: probability-smoothed Croston variant.

    p (demand probability) updates every usable period with alpha_p on the
    0/1 occurrence indicator — including zero periods, so p decays toward 0
    for dying items. z (demand size) updates with alpha_z only on demand
    periods. Initialization: p = occurrence of the first usable period;
    z = size of the first demand. Forecast = p * z, flat across horizons
    (0.0 when the series never had a demand).
    """

    model_id = "M9"
    min_history_weeks = 13
    handles_intermittent = True

    def __init__(self, alpha_p: float = 0.1, alpha_z: float = 0.1) -> None:
        super().__init__()
        self.alpha_p = float(alpha_p)
        self.alpha_z = float(alpha_z)

    def _fit(self, Y_prefix: np.ndarray, usable_prefix: np.ndarray, origin_idx: int) -> None:
        H = masked_history(Y_prefix, usable_prefix)
        n, T = H.shape
        ap, az = self.alpha_p, self.alpha_z
        p = np.full(n, np.nan)
        z = np.full(n, np.nan)
        for t in range(T):
            y = H[:, t]
            valid = ~np.isnan(y)
            d = (valid & (y > 0)).astype(float)
            upd_p = valid & ~np.isnan(p)
            if upd_p.any():
                p[upd_p] += ap * (d[upd_p] - p[upd_p])
            init_p = valid & np.isnan(p)
            if init_p.any():
                p[init_p] = d[init_p]
            dem = valid & (y > 0)
            init_z = dem & np.isnan(z)
            if init_z.any():
                z[init_z] = y[init_z]
            upd_z = dem & ~np.isnan(z) & ~init_z
            if upd_z.any():
                z[upd_z] += az * (y[upd_z] - z[upd_z])
        pred = np.where(np.isnan(z), 0.0, p * z)
        pred[np.isnan(p)] = 0.0
        pred[insufficient_history(Y_prefix, usable_prefix, self.min_history_weeks)] = np.nan
        self._pred = pred

    def _predict(self, horizons: list[int]) -> np.ndarray:
        return _flat(self._pred, horizons)
