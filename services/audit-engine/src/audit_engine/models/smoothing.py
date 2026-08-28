"""M6 SES and M7 Theta.

Both are vectorized across series: the SES recursion loops over weeks only,
with (n_series, n_alphas) state arrays. NaN cells (unusable / out-of-lifespan
weeks) are simply skipped by the recursion, which is equivalent to running SES
on each series compressed to its usable values.
"""
from __future__ import annotations

import numpy as np

from .base import BatchModel, insufficient_history, masked_history


def ses_grid(H: np.ndarray, alphas: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Run the SES recursion for every alpha simultaneously.

    H: (n_series, T) masked history (NaN = skip).
    Returns (levels, mae): both (n_series, n_alphas). ``levels`` is the final
    smoothed level; ``mae`` the in-prefix one-step MAE (error measured against
    the level *before* each update, i.e. a true one-step-ahead error). Rows
    with fewer than 2 valid observations get NaN MAE.
    """
    alphas = np.asarray(alphas, dtype=float)
    n, T = H.shape
    a = len(alphas)
    L = np.full((n, a), np.nan)
    err_sum = np.zeros((n, a))
    err_cnt = np.zeros(n)
    initialized = np.zeros(n, dtype=bool)
    for t in range(T):
        y = H[:, t]
        valid = ~np.isnan(y)
        upd = valid & initialized
        if upd.any():
            resid = y[upd, None] - L[upd]
            err_sum[upd] += np.abs(resid)
            err_cnt[upd] += 1
            L[upd] = L[upd] + alphas[None, :] * resid
        init = valid & ~initialized
        if init.any():
            L[init] = y[init, None]
            initialized[init] = True
    with np.errstate(divide="ignore", invalid="ignore"):
        mae = err_sum / np.maximum(err_cnt, 1)[:, None]
    mae[err_cnt == 0] = np.nan
    return L, mae


def _pick_alpha(L: np.ndarray, mae: np.ndarray, alphas: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Per-series argmin of MAE over the alpha grid -> (level, alpha)."""
    mae_safe = np.where(np.isnan(mae), np.inf, mae)
    best = np.argmin(mae_safe, axis=1)
    rows = np.arange(L.shape[0])
    return L[rows, best], np.asarray(alphas, dtype=float)[best]


def compress(H: np.ndarray) -> np.ndarray:
    """Left-pack each row's non-NaN values; NaN-pad the right. Fully vectorized."""
    valid = ~np.isnan(H)
    counts = valid.sum(axis=1)
    width = max(int(counts.max()) if counts.size else 0, 1)
    C = np.full((H.shape[0], width), np.nan)
    if H.shape[1]:
        pos = np.cumsum(valid, axis=1) - 1
        r, c = np.nonzero(valid)
        C[r, pos[r, c]] = H[r, c]
    return C


class SES(BatchModel):
    """M6 — simple exponential smoothing, alpha grid-fitted per series.

    alpha grid = np.linspace(bounds[0], bounds[1], 8) so the fitted alpha is
    clamped to the config bounds by construction. Per-series alpha minimizes
    the in-prefix one-step MAE; the forecast is the final level, flat.
    """

    model_id = "M6"
    min_history_weeks = 8

    def __init__(self, alpha_bounds: tuple[float, float] = (0.05, 0.40), n_grid: int = 8) -> None:
        super().__init__()
        self.alpha_bounds = (float(alpha_bounds[0]), float(alpha_bounds[1]))
        self.n_grid = int(n_grid)
        self.alpha_: np.ndarray | None = None

    def _fit(self, Y_prefix: np.ndarray, usable_prefix: np.ndarray, origin_idx: int) -> None:
        H = masked_history(Y_prefix, usable_prefix)
        alphas = np.linspace(self.alpha_bounds[0], self.alpha_bounds[1], self.n_grid)
        L, mae = ses_grid(H, alphas)
        level, alpha = _pick_alpha(L, mae, alphas)
        insuff = insufficient_history(Y_prefix, usable_prefix, self.min_history_weeks)
        level[insuff] = np.nan
        alpha[insuff] = np.nan
        self._level = level
        self.alpha_ = alpha

    def _predict(self, horizons: list[int]) -> np.ndarray:
        return np.tile(self._level[:, None], (1, len(horizons)))


class Theta(BatchModel):
    """M7 — classic two-theta-line Theta (standard M4-competition simplification).

    Formulation (documented):
      1. Compress each series to its usable values y_1..y_n (t = 0..n-1).
      2. Fit a linear trend a + b*t by least squares over the usable prefix
         (the theta=0 line).
      3. theta=2 line: z_t = 2*y_t - (a + b*t).
      4. SES the theta2 line; alpha fitted per series on the same
         np.linspace(alpha_bounds, 8) grid as M6 (chosen over fixed 0.2 so the
         recency weighting adapts per series; documented choice).
      5. forecast(h) = 0.5 * SES_level(theta2) + 0.5 * (a + b*(n - 1 + h))
         i.e. equal-weight combination of the SES level and the trend
         extrapolated h steps past the last usable observation — equivalently
         the SES level plus an h-adjusted half slope of the fitted trend.
    """

    model_id = "M7"
    min_history_weeks = 13

    def __init__(self, alpha_bounds: tuple[float, float] = (0.05, 0.40), n_grid: int = 8) -> None:
        super().__init__()
        self.alpha_bounds = (float(alpha_bounds[0]), float(alpha_bounds[1]))
        self.n_grid = int(n_grid)

    def _fit(self, Y_prefix: np.ndarray, usable_prefix: np.ndarray, origin_idx: int) -> None:
        H = masked_history(Y_prefix, usable_prefix)
        C = compress(H)
        valid = ~np.isnan(C)
        n_i = valid.sum(axis=1).astype(float)
        t = np.arange(C.shape[1], dtype=float)[None, :]
        # Least-squares trend over the compressed usable prefix, per series.
        St = (valid * t).sum(axis=1)
        St2 = (valid * t**2).sum(axis=1)
        Sy = np.nansum(np.where(valid, C, 0.0), axis=1)
        Sty = np.nansum(np.where(valid, C * t, 0.0), axis=1)
        denom = n_i * St2 - St**2
        with np.errstate(divide="ignore", invalid="ignore"):
            b = np.where(denom > 0, (n_i * Sty - St * Sy) / np.where(denom > 0, denom, 1.0), 0.0)
            a = np.where(n_i > 0, (Sy - b * St) / np.maximum(n_i, 1), np.nan)
        trend = a[:, None] + b[:, None] * t
        Z = 2.0 * C - trend  # NaN pattern of C preserved
        alphas = np.linspace(self.alpha_bounds[0], self.alpha_bounds[1], self.n_grid)
        L, mae = ses_grid(Z, alphas)
        level2, _ = _pick_alpha(L, mae, alphas)
        insuff = insufficient_history(Y_prefix, usable_prefix, self.min_history_weeks)
        level2[insuff] = np.nan
        a[insuff] = np.nan
        self._level2 = level2
        self._a = a
        self._b = b
        self._n = n_i

    def _predict(self, horizons: list[int]) -> np.ndarray:
        hs = np.asarray(horizons, dtype=float)[None, :]
        trend_ex = self._a[:, None] + self._b[:, None] * (self._n[:, None] - 1.0 + hs)
        return 0.5 * self._level2[:, None] + 0.5 * trend_ex
