"""Broad-statistical models: M18-M22.

All vectorized across series — the only Python loops are over weeks (Holt /
DampedHolt recursions) or over a small parameter grid. NaN cells (unusable /
out-of-lifespan weeks) are compressed away with the ``compress`` helper before
fitting so trend and averaging logic sees a dense, chronologically-ordered
usable series. Count demand is non-negative, so every forecast is floored at 0.
Series below min_history predict NaN.
"""
from __future__ import annotations

import numpy as np

from .base import BatchModel, insufficient_history, masked_history
from .naive import _flat, last_n_mask
from .smoothing import compress


def _holt_grid(
    C: np.ndarray, alphas: np.ndarray, betas: np.ndarray, phi: float
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Run Holt's linear trend recursion for every (alpha, beta) pair at once.

    ``C`` is the compressed (left-packed, NaN-padded) usable series. ``phi`` is
    the trend damping (1.0 = undamped Holt). Returns (level, trend, alpha_sel,
    beta_sel): the final level and trend per series for the (alpha, beta) pair
    minimizing in-sample one-step MAE, plus the selected pair.

    Level/trend init: level = first usable value, trend = second - first
    (0 if only one usable value). One-step forecast at each step is
    level + phi*trend (before the update), giving a true one-step-ahead error.
    """
    n, W = C.shape
    pairs = [(a, b) for a in alphas for b in betas]
    k = len(pairs)
    a_vec = np.array([a for a, _ in pairs])
    b_vec = np.array([b for _, b in pairs])

    L = np.full((n, k), np.nan)
    Tr = np.full((n, k), np.nan)
    err_sum = np.zeros((n, k))
    err_cnt = np.zeros(n)
    seen = np.zeros(n, dtype=int)  # usable values consumed so far

    valid = ~np.isnan(C)
    for t in range(W):
        y = C[:, t]
        v = valid[:, t]
        # First usable value: seed the level.
        first = v & (seen == 0)
        if first.any():
            L[first] = y[first, None]
            Tr[first] = 0.0
        # Second usable value: seed the trend, and score the one-step error
        # of the pure-level forecast made at step 1.
        second = v & (seen == 1)
        if second.any():
            fc = L[second] + phi * Tr[second]  # = level (trend still 0)
            err_sum[second] += np.abs(y[second, None] - fc)
            err_cnt[second] += 1
            Tr[second] = y[second, None] - L[second]
            L[second] = y[second, None]
        # Third onward: score one-step error, then Holt update.
        rest = v & (seen >= 2)
        if rest.any():
            fc = L[rest] + phi * Tr[rest]
            err_sum[rest] += np.abs(y[rest, None] - fc)
            err_cnt[rest] += 1
            lvl_prev = L[rest]
            tr_prev = Tr[rest]
            new_L = a_vec[None, :] * y[rest, None] + (1 - a_vec[None, :]) * (lvl_prev + phi * tr_prev)
            new_Tr = b_vec[None, :] * (new_L - lvl_prev) + (1 - b_vec[None, :]) * phi * tr_prev
            L[rest] = new_L
            Tr[rest] = new_Tr
        seen[v] += 1

    with np.errstate(divide="ignore", invalid="ignore"):
        mae = err_sum / np.maximum(err_cnt, 1)[:, None]
    mae[err_cnt == 0] = np.nan
    mae_safe = np.where(np.isnan(mae), np.inf, mae)
    best = np.argmin(mae_safe, axis=1)
    rows = np.arange(n)
    return L[rows, best], Tr[rows, best], a_vec[best], b_vec[best]


class Holt(BatchModel):
    """M18 — Holt's linear trend (additive level + trend).

    alpha and beta are grid-fitted per series over small clamped grids by
    minimizing in-sample one-step MAE. Forecast(h) = level + h*trend, floored
    at 0 (count demand). Flat trend continuation across the horizon.
    """

    model_id = "M18"
    min_history_weeks = 8
    handles_intermittent = False

    def __init__(
        self,
        alpha_bounds: tuple[float, float] = (0.10, 0.60),
        beta_bounds: tuple[float, float] = (0.05, 0.30),
        n_grid: int = 4,
    ) -> None:
        super().__init__()
        self.alpha_bounds = (float(alpha_bounds[0]), float(alpha_bounds[1]))
        self.beta_bounds = (float(beta_bounds[0]), float(beta_bounds[1]))
        self.n_grid = int(n_grid)
        self.phi = 1.0

    def _fit(self, Y_prefix: np.ndarray, usable_prefix: np.ndarray, origin_idx: int) -> None:
        H = masked_history(Y_prefix, usable_prefix)
        C = compress(H)
        alphas = np.linspace(self.alpha_bounds[0], self.alpha_bounds[1], self.n_grid)
        betas = np.linspace(self.beta_bounds[0], self.beta_bounds[1], self.n_grid)
        level, trend, self.alpha_, self.beta_ = _holt_grid(C, alphas, betas, self.phi)
        insuff = insufficient_history(Y_prefix, usable_prefix, self.min_history_weeks)
        level[insuff] = np.nan
        trend[insuff] = np.nan
        self._level = level
        self._trend = trend

    def _predict(self, horizons: list[int]) -> np.ndarray:
        hs = np.asarray(horizons, dtype=float)[None, :]
        out = self._level[:, None] + hs * self._trend[:, None]
        return np.where(out < 0, 0.0, out)


class DampedHolt(BatchModel):
    """M19 — Holt with a damped trend.

    Same level/trend recursion as M18 but the trend contribution decays by a
    damping factor phi (default 0.9) each step, in fit and in forecast.
    Forecast(h) = level + (phi + phi^2 + ... + phi^h) * trend, floored at 0.
    The damped horizon sum flattens the extrapolation, so on an upward trend
    the M19 forecast is strictly below the undamped M18 forecast at h > 1.
    """

    model_id = "M19"
    min_history_weeks = 8
    handles_intermittent = False

    def __init__(
        self,
        alpha_bounds: tuple[float, float] = (0.10, 0.60),
        beta_bounds: tuple[float, float] = (0.05, 0.30),
        n_grid: int = 4,
        phi: float = 0.9,
    ) -> None:
        super().__init__()
        self.alpha_bounds = (float(alpha_bounds[0]), float(alpha_bounds[1]))
        self.beta_bounds = (float(beta_bounds[0]), float(beta_bounds[1]))
        self.n_grid = int(n_grid)
        self.phi = float(phi)

    def _fit(self, Y_prefix: np.ndarray, usable_prefix: np.ndarray, origin_idx: int) -> None:
        H = masked_history(Y_prefix, usable_prefix)
        C = compress(H)
        alphas = np.linspace(self.alpha_bounds[0], self.alpha_bounds[1], self.n_grid)
        betas = np.linspace(self.beta_bounds[0], self.beta_bounds[1], self.n_grid)
        level, trend, self.alpha_, self.beta_ = _holt_grid(C, alphas, betas, self.phi)
        insuff = insufficient_history(Y_prefix, usable_prefix, self.min_history_weeks)
        level[insuff] = np.nan
        trend[insuff] = np.nan
        self._level = level
        self._trend = trend

    def _predict(self, horizons: list[int]) -> np.ndarray:
        phi = self.phi
        # Damped horizon multiplier phi + phi^2 + ... + phi^h per horizon.
        mult = np.array([sum(phi**i for i in range(1, h + 1)) for h in horizons], dtype=float)
        out = self._level[:, None] + mult[None, :] * self._trend[:, None]
        return np.where(out < 0, 0.0, out)


class WeightedMA(BatchModel):
    """M20 — linearly-weighted moving average of the last N usable weeks.

    Over the last N=8 usable values, weight the most recent by N and the
    oldest (of that window) by 1, normalizing by the sum of used weights.
    Recency-biased relative to a flat MA. Flat across horizons, floored at 0.
    """

    model_id = "M20"
    min_history_weeks = 4
    handles_intermittent = False

    def __init__(self, n: int = 8) -> None:
        super().__init__()
        self.n = int(n)

    def _fit(self, Y_prefix: np.ndarray, usable_prefix: np.ndarray, origin_idx: int) -> None:
        H = masked_history(Y_prefix, usable_prefix)
        C = compress(H)  # left-packed; the last N valid columns are the window
        valid = ~np.isnan(C)
        mask = last_n_mask(valid, self.n)
        counts = mask.sum(axis=1).astype(int)
        # Per-row rank of window cells from oldest(1)..newest; used as weights.
        # rank_from_right counts newest=1; convert to newest=highest weight.
        rank_from_right = np.cumsum(mask[:, ::-1], axis=1)[:, ::-1]
        # Within the window, cnt - rank_from_right + 1 gives oldest=1..newest=cnt.
        weight = np.where(mask, counts[:, None] - rank_from_right + 1, 0.0)
        vals = np.where(mask, C, 0.0)
        wsum = weight.sum(axis=1)
        with np.errstate(divide="ignore", invalid="ignore"):
            pred = np.where(wsum > 0, (weight * vals).sum(axis=1) / np.maximum(wsum, 1e-12), np.nan)
        pred = np.where(pred < 0, 0.0, pred)
        pred[insufficient_history(Y_prefix, usable_prefix, self.min_history_weeks)] = np.nan
        self._pred = pred

    def _predict(self, horizons: list[int]) -> np.ndarray:
        return _flat(self._pred, horizons)


class TrimmedMean(BatchModel):
    """M21 — trimmed mean of the last 13 usable weeks.

    Over the trailing window, drop the single highest and single lowest value
    and average the rest — robust to a one-off spike or dip. If the window has
    2 or fewer values the plain mean is used. Flat across horizons, floored
    at 0.
    """

    model_id = "M21"
    min_history_weeks = 6
    handles_intermittent = False

    def __init__(self, window: int = 13) -> None:
        super().__init__()
        self.window = int(window)

    def _fit(self, Y_prefix: np.ndarray, usable_prefix: np.ndarray, origin_idx: int) -> None:
        H = masked_history(Y_prefix, usable_prefix)
        C = compress(H)
        valid = ~np.isnan(C)
        mask = last_n_mask(valid, self.window)
        counts = mask.sum(axis=1).astype(float)
        # Window values with non-window cells set to NaN, then per-row min/max
        # located and subtracted out (one occurrence each).
        W = np.where(mask, C, np.nan)
        with np.errstate(invalid="ignore"):
            wsum = np.nansum(W, axis=1)
            wmin = np.nanmin(np.where(mask, C, np.inf), axis=1)
            wmax = np.nanmax(np.where(mask, C, -np.inf), axis=1)
        # Trim: subtract one min and one max when >= 3 values, else plain mean.
        trim = counts >= 3
        num = np.where(trim, wsum - wmin - wmax, wsum)
        den = np.where(trim, np.maximum(counts - 2, 1), np.maximum(counts, 1))
        with np.errstate(divide="ignore", invalid="ignore"):
            pred = np.where(counts > 0, num / den, np.nan)
        pred = np.where(pred < 0, 0.0, pred)
        pred[insufficient_history(Y_prefix, usable_prefix, self.min_history_weeks)] = np.nan
        self._pred = pred

    def _predict(self, horizons: list[int]) -> np.ndarray:
        return _flat(self._pred, horizons)


class RecencyPoissonRate(BatchModel):
    """M22 — recency-weighted Poisson rate.

    An honest rate estimator, NOT a full GLM: with no covariates available in
    the panel, "GLM-Poisson" reduces to estimating a single Poisson rate per
    series. That rate is the exponentially recency-weighted mean of the usable
    values (half-life 8 usable weeks), which is robust to zeros because the
    mean of zeros is a valid rate estimate. Flat across horizons, floored at 0.
    """

    model_id = "M22"
    min_history_weeks = 6
    handles_intermittent = True

    def __init__(self, half_life: float = 8.0) -> None:
        super().__init__()
        self.half_life = float(half_life)

    def _fit(self, Y_prefix: np.ndarray, usable_prefix: np.ndarray, origin_idx: int) -> None:
        H = masked_history(Y_prefix, usable_prefix)
        C = compress(H)  # left-packed usable values, oldest..newest
        valid = ~np.isnan(C)
        counts = valid.sum(axis=1).astype(int)
        W = C.shape[1]
        # Age of each usable cell measured from the newest usable value:
        # newest has age 0. rank_from_right: newest=1 -> age = rank-1.
        rank_from_right = np.cumsum(valid[:, ::-1], axis=1)[:, ::-1]
        age = np.where(valid, rank_from_right - 1, 0.0)
        decay = np.log(2.0) / self.half_life
        weight = np.where(valid, np.exp(-decay * age), 0.0)
        vals = np.where(valid, C, 0.0)
        wsum = weight.sum(axis=1)
        with np.errstate(divide="ignore", invalid="ignore"):
            pred = np.where(wsum > 0, (weight * vals).sum(axis=1) / np.maximum(wsum, 1e-12), np.nan)
        pred = np.where(pred < 0, 0.0, pred)
        pred[insufficient_history(Y_prefix, usable_prefix, self.min_history_weeks)] = np.nan
        self._pred = pred

    def _predict(self, horizons: list[int]) -> np.ndarray:
        return _flat(self._pred, horizons)
