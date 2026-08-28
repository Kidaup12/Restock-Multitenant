"""Intermittent-demand extensions: M13-M17.

Same vectorization discipline as intermittent.py — the smoothing recursions
loop over weeks (or over the small set of distinct block sizes for ADIDA),
with all state held in per-series numpy arrays. NaN cells (unusable /
out-of-lifespan weeks) are skipped: they advance neither intervals nor
probabilities, matching the "treat as missing, not zero" contract.

A demand period is a usable week with value > 0. Series with sufficient
history but no positive demand at all forecast 0.0 (a dead item, not
missing data).
"""
from __future__ import annotations

import numpy as np

from .base import BatchModel, insufficient_history, masked_history
from .naive import _flat
from .smoothing import compress, ses_grid


def _croston_recursion(
    H: np.ndarray, alpha_z: np.ndarray, alpha_p: np.ndarray
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Croston size/interval SES with per-series alphas.

    ``alpha_z`` / ``alpha_p`` are (n_series,) smoothing constants applied to
    demand sizes z and inter-demand intervals p respectively. Returns
    (z, p, has_demand): final smoothed size, final smoothed interval (in
    usable periods), and whether the series ever had a demand.
    """
    n, T = H.shape
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
            z[upd] += alpha_z[upd] * (y[upd] - z[upd])
            p[upd] += alpha_p[upd] * (q[upd] - p[upd])
        has_demand |= dem
        q[dem] = 0.0
    return z, p, has_demand


class CrostonOriginal(BatchModel):
    """M13 — classic Croston, no SBA bias correction.

    Separate SES with a fixed alpha (default 0.1) on demand sizes z and on
    inter-demand intervals p (measured in usable periods). Forecast =
    z / p, flat across horizons. This is the uncorrected original; M8 is the
    Syntetos-Boylan (1 - alpha/2)-corrected variant kept alongside it for
    comparison.
    """

    model_id = "M13"
    min_history_weeks = 13
    handles_intermittent = True

    def __init__(self, alpha: float = 0.1) -> None:
        super().__init__()
        self.alpha = float(alpha)

    def _fit(self, Y_prefix: np.ndarray, usable_prefix: np.ndarray, origin_idx: int) -> None:
        H = masked_history(Y_prefix, usable_prefix)
        n = H.shape[0]
        a = np.full(n, self.alpha)
        z, p, has_demand = _croston_recursion(H, a, a)
        with np.errstate(divide="ignore", invalid="ignore"):
            pred = np.where(has_demand, z / p, 0.0)
        pred[insufficient_history(Y_prefix, usable_prefix, self.min_history_weeks)] = np.nan
        self._pred = pred

    def _predict(self, horizons: list[int]) -> np.ndarray:
        return _flat(self._pred, horizons)


class CrostonSBAOpt(BatchModel):
    """M14 — SBA-corrected Croston with alpha grid-fitted per series.

    A shared alpha smooths both sizes and intervals; it is chosen per series
    from a grid over [0.05, 0.4] by minimizing an in-sample one-step
    MASE-like error on the compressed usable series (mean abs one-step
    residual, scaled by the naive one-step scale). Forecast =
    (z / p) * (1 - alpha / 2), flat across horizons.
    """

    model_id = "M14"
    min_history_weeks = 13
    handles_intermittent = True

    def __init__(self, alpha_bounds: tuple[float, float] = (0.05, 0.40), n_grid: int = 8) -> None:
        super().__init__()
        self.alpha_bounds = (float(alpha_bounds[0]), float(alpha_bounds[1]))
        self.n_grid = int(n_grid)
        self.alpha_: np.ndarray | None = None

    def _fit(self, Y_prefix: np.ndarray, usable_prefix: np.ndarray, origin_idx: int) -> None:
        H = masked_history(Y_prefix, usable_prefix)
        n = H.shape[0]
        alphas = np.linspace(self.alpha_bounds[0], self.alpha_bounds[1], self.n_grid)
        C = compress(H)  # left-packed usable series; SES-fit alpha on this
        # One-step SES MAE per (series, alpha), reused as the intermittent
        # fit criterion (MASE numerator). ses_grid already skips NaN pads.
        _, mae = ses_grid(C, alphas)
        # Naive one-step scale = mean abs first difference of the compressed
        # series (MASE denominator); constant across alphas, so it only sets
        # the argmin's scale — argmin is unchanged, but we compute it so the
        # criterion is a genuine MASE-like value, not raw MAE.
        valid = ~np.isnan(C)
        diffs = np.abs(np.diff(np.where(valid, C, np.nan), axis=1))
        with np.errstate(invalid="ignore"):
            scale = np.nanmean(diffs, axis=1)
        scale = np.where((scale > 0) & np.isfinite(scale), scale, 1.0)
        mase = mae / scale[:, None]
        mase_safe = np.where(np.isnan(mase), np.inf, mase)
        best = np.argmin(mase_safe, axis=1)
        alpha = alphas[best]
        # Series with no usable one-step error (all-inf row) default to 0.1.
        no_err = np.isinf(mase_safe).all(axis=1)
        alpha[no_err] = 0.1
        z, p, has_demand = _croston_recursion(H, alpha, alpha)
        with np.errstate(divide="ignore", invalid="ignore"):
            pred = np.where(has_demand, (z / p) * (1.0 - alpha / 2.0), 0.0)
        insuff = insufficient_history(Y_prefix, usable_prefix, self.min_history_weeks)
        pred[insuff] = np.nan
        alpha[insuff] = np.nan
        self._pred = pred
        self.alpha_ = alpha

    def _predict(self, horizons: list[int]) -> np.ndarray:
        return _flat(self._pred, horizons)


class TSBOpt(BatchModel):
    """M15 — TSB with alpha_p and alpha_z grid-fitted per series.

    Runs the TSB recursion once for every (alpha_p, alpha_z) pair on a small
    3x3 grid over [0.05, 0.3], tracking the in-sample one-step MAE of the
    p*z forecast against each usable period's realized demand, and keeps the
    per-series pair that minimizes it. Forecast = p * z, flat across
    horizons (0.0 when the series never had a demand).
    """

    model_id = "M15"
    min_history_weeks = 13
    handles_intermittent = True

    def __init__(self, grid: tuple[float, float] = (0.05, 0.30), n_grid: int = 3) -> None:
        super().__init__()
        self.grid = (float(grid[0]), float(grid[1]))
        self.n_grid = int(n_grid)
        self.alpha_p_: np.ndarray | None = None
        self.alpha_z_: np.ndarray | None = None

    def _fit(self, Y_prefix: np.ndarray, usable_prefix: np.ndarray, origin_idx: int) -> None:
        H = masked_history(Y_prefix, usable_prefix)
        n, T = H.shape
        g = np.linspace(self.grid[0], self.grid[1], self.n_grid)
        pairs = [(ap, az) for ap in g for az in g]
        k = len(pairs)
        ap_vec = np.array([ap for ap, _ in pairs])
        az_vec = np.array([az for _, az in pairs])

        # (n, k) state, one column per grid pair — a vectorized fan-out over
        # the small parameter grid; still no per-series loop.
        p = np.full((n, k), np.nan)
        z = np.full((n, k), np.nan)
        err_sum = np.zeros((n, k))
        err_cnt = np.zeros(n)
        # p/z init/update status is uniform across the k grid columns, so
        # per-series (1-D) masks drive the (n, k) state updates.
        p_init = np.zeros(n, dtype=bool)  # p seeded (first usable period)
        z_init = np.zeros(n, dtype=bool)  # z seeded (first demand)
        for t in range(T):
            y = H[:, t]
            valid = ~np.isnan(y)
            d = (valid & (y > 0)).astype(float)
            # One-step forecast error, scored on every usable period once p,z
            # are both initialized (forecast = p*z from the prior state).
            ready = valid & p_init & z_init
            if ready.any():
                fc = p[ready] * z[ready]
                err_sum[ready] += np.abs(y[ready, None] - fc)
                err_cnt[ready] += 1
            # p updates on every usable period (occurrence indicator).
            upd_p = valid & p_init
            if upd_p.any():
                p[upd_p] += ap_vec[None, :] * (d[upd_p, None] - p[upd_p])
            init_p = valid & ~p_init
            if init_p.any():
                p[init_p] = d[init_p, None]
                p_init[init_p] = True
            # z updates only on demand periods.
            dem = valid & (y > 0)
            init_z = dem & ~z_init
            if init_z.any():
                z[init_z] = y[init_z, None]
                z_init[init_z] = True
            upd_z = dem & z_init & ~init_z
            if upd_z.any():
                z[upd_z] += az_vec[None, :] * (y[upd_z, None] - z[upd_z])

        with np.errstate(divide="ignore", invalid="ignore"):
            mae = err_sum / np.maximum(err_cnt, 1)[:, None]
        mae[err_cnt == 0] = np.nan
        mae_safe = np.where(np.isnan(mae), np.inf, mae)
        best = np.argmin(mae_safe, axis=1)
        rows = np.arange(n)
        p_best = p[rows, best]
        z_best = z[rows, best]
        pred = np.where(np.isnan(z_best), 0.0, p_best * z_best)
        pred[np.isnan(p_best)] = 0.0
        insuff = insufficient_history(Y_prefix, usable_prefix, self.min_history_weeks)
        pred[insuff] = np.nan
        self._pred = pred
        self.alpha_p_ = np.where(insuff, np.nan, ap_vec[best])
        self.alpha_z_ = np.where(insuff, np.nan, az_vec[best])

    def _predict(self, horizons: list[int]) -> np.ndarray:
        return _flat(self._pred, horizons)


class ADIDA(BatchModel):
    """M16 — Aggregate-Disaggregate Intermittent Demand Approach.

    Per series: aggregation size = round(mean inter-demand interval), clamped
    to [1, 8]. The compressed usable series is summed into non-overlapping
    blocks of that size (right-aligned so the most recent block is complete),
    SES is applied to the aggregated blocks, and the level is disaggregated
    back to a per-week rate by dividing equally by the block size. Forecast is
    that flat per-week rate.

    Vectorized by looping over the (at most 8) distinct block sizes, not over
    series: for each size, the matching series are aggregated and SES-fitted
    together with ses_grid.
    """

    model_id = "M16"
    min_history_weeks = 13
    handles_intermittent = True

    def __init__(self, alpha_bounds: tuple[float, float] = (0.05, 0.40), n_grid: int = 8) -> None:
        super().__init__()
        self.alpha_bounds = (float(alpha_bounds[0]), float(alpha_bounds[1]))
        self.n_grid = int(n_grid)

    def _fit(self, Y_prefix: np.ndarray, usable_prefix: np.ndarray, origin_idx: int) -> None:
        H = masked_history(Y_prefix, usable_prefix)
        n = H.shape[0]
        C = compress(H)  # (n, W) left-packed usable values, NaN-padded right
        valid = ~np.isnan(C)
        counts = valid.sum(axis=1).astype(int)

        # Mean inter-demand interval = usable periods / number of demands.
        demands = (np.nan_to_num(C, nan=0.0) > 0).sum(axis=1)
        with np.errstate(divide="ignore", invalid="ignore"):
            adi = np.where(demands > 0, counts / np.maximum(demands, 1), 1.0)
        block = np.clip(np.round(adi).astype(int), 1, 8)
        block[demands == 0] = 1  # dead item -> weekly rate of 0

        alphas = np.linspace(self.alpha_bounds[0], self.alpha_bounds[1], self.n_grid)
        pred = np.full(n, np.nan)
        C0 = np.where(valid, C, 0.0)  # zero-filled for block summation
        for b in np.unique(block):
            rows = np.nonzero(block == b)[0]
            if rows.size == 0:
                continue
            sub = C0[rows]
            cnt = counts[rows]
            # Right-align each series so the trailing block is complete, then
            # aggregate into non-overlapping windows of width b.
            agg = self._aggregate(sub, cnt, int(b))
            L, mae = ses_grid(agg, alphas)
            mae_safe = np.where(np.isnan(mae), np.inf, mae)
            best = np.argmin(mae_safe, axis=1)
            level = L[np.arange(L.shape[0]), best]
            pred[rows] = level / float(b)  # disaggregate to a per-week rate

        with np.errstate(invalid="ignore"):
            pred = np.where(pred < 0, 0.0, pred)
        pred[insufficient_history(Y_prefix, usable_prefix, self.min_history_weeks)] = np.nan
        self._pred = pred

    @staticmethod
    def _aggregate(sub: np.ndarray, cnt: np.ndarray, b: int) -> np.ndarray:
        """Sum each row's usable values into non-overlapping blocks of width b.

        Rows are right-aligned (the newest observations fill the final block)
        so the most recent aggregated period is always complete; leading
        partial data is dropped. Returns a NaN-padded (n, n_blocks) matrix of
        block sums for ses_grid.
        """
        n, W = sub.shape
        nb_per_row = cnt // b  # complete blocks available per row
        max_nb = int(nb_per_row.max()) if n else 0
        if max_nb == 0:
            # Not enough usable weeks for even one block: fall back to the
            # per-row usable mean * b as a single aggregated block.
            with np.errstate(invalid="ignore"):
                mean = np.where(cnt > 0, sub.sum(axis=1) / np.maximum(cnt, 1), 0.0)
            return (mean * b)[:, None]
        out = np.full((n, max_nb), np.nan)
        for i in range(n):
            c = int(cnt[i])
            nb = int(nb_per_row[i])
            if nb == 0:
                continue
            vals = sub[i, :c]  # the c usable values, oldest..newest
            used = vals[c - nb * b:]  # keep the trailing nb*b, drop leading
            blocks = used.reshape(nb, b).sum(axis=1)
            out[i, max_nb - nb:] = blocks  # right-align blocks in the matrix
        return out

    def _predict(self, horizons: list[int]) -> np.ndarray:
        return _flat(self._pred, horizons)


class ZeroForecast(BatchModel):
    """M17 — always predicts 0.

    A deliberate control/floor for a catalogue that is mostly zero: any real
    model must beat this baseline, and it exposes WAPE's degeneracy (a
    zero-forecast can score deceptively well when actuals are near zero).
    Predicts 0.0 for every series with sufficient history, NaN otherwise.
    """

    model_id = "M17"
    min_history_weeks = 1
    handles_intermittent = True

    def _fit(self, Y_prefix: np.ndarray, usable_prefix: np.ndarray, origin_idx: int) -> None:
        n = Y_prefix.shape[0]
        pred = np.zeros(n)
        pred[insufficient_history(Y_prefix, usable_prefix, self.min_history_weeks)] = np.nan
        self._pred = pred

    def _predict(self, horizons: list[int]) -> np.ndarray:
        return _flat(self._pred, horizons)
