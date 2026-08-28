"""Naive floor models M1-M3 and the moving-average benchmarks M4_n.

All models are vectorized across series: the only Python loops anywhere in
this module are over array axes handled by numpy. "Usable value" means a
prefix cell that is both usable (usable_prefix True) and non-NaN; helpers
below operate on the masked history from ``masked_history``.
"""
from __future__ import annotations

import numpy as np

from .base import BatchModel, insufficient_history, masked_history


def last_valid(H: np.ndarray) -> np.ndarray:
    """(n_series,) last non-NaN value per row; NaN when a row has none."""
    n, T = H.shape
    out = np.full(n, np.nan)
    if T == 0:
        return out
    valid = ~np.isnan(H)
    any_valid = valid.any(axis=1)
    idx = T - 1 - np.argmax(valid[:, ::-1], axis=1)
    rows = np.nonzero(any_valid)[0]
    out[rows] = H[rows, idx[rows]]
    return out


def first_valid(H: np.ndarray) -> np.ndarray:
    """(n_series,) first non-NaN value per row; NaN when a row has none."""
    n, T = H.shape
    out = np.full(n, np.nan)
    if T == 0:
        return out
    valid = ~np.isnan(H)
    any_valid = valid.any(axis=1)
    idx = np.argmax(valid, axis=1)
    rows = np.nonzero(any_valid)[0]
    out[rows] = H[rows, idx[rows]]
    return out


def last_n_mask(valid: np.ndarray, n: int) -> np.ndarray:
    """Bool mask marking, per row, the last ``n`` True cells of ``valid``."""
    if valid.shape[1] == 0:
        return valid.copy()
    rank_from_right = np.cumsum(valid[:, ::-1], axis=1)[:, ::-1]
    return valid & (rank_from_right <= n)


def _flat(values: np.ndarray, horizons: list[int]) -> np.ndarray:
    """Tile a per-series vector into a flat (n_series, len(horizons)) forecast."""
    return np.tile(np.asarray(values, dtype=float)[:, None], (1, len(horizons)))


class NaiveLast(BatchModel):
    """M1 — last usable non-NaN value per series, flat across horizons."""

    model_id = "M1"
    min_history_weeks = 1

    def _fit(self, Y_prefix: np.ndarray, usable_prefix: np.ndarray, origin_idx: int) -> None:
        H = masked_history(Y_prefix, usable_prefix)
        pred = last_valid(H)
        pred[insufficient_history(Y_prefix, usable_prefix, self.min_history_weeks)] = np.nan
        self._pred = pred

    def _predict(self, horizons: list[int]) -> np.ndarray:
        return _flat(self._pred, horizons)


class NaiveSeasonal(BatchModel):
    """M2 — value 52 weeks before the target week; NaN below 52w of history.

    The prefix columns share the panel calendar, so the target week
    origin_idx + h - 1 reads from prefix column origin_idx + h - 1 - 52.
    """

    model_id = "M2"

    def __init__(self, min_history_weeks: int = 52, season_length: int = 52) -> None:
        super().__init__()
        self.min_history_weeks = int(min_history_weeks)
        self.season_length = int(season_length)

    def _fit(self, Y_prefix: np.ndarray, usable_prefix: np.ndarray, origin_idx: int) -> None:
        self._H = masked_history(Y_prefix, usable_prefix)
        self._insuff = insufficient_history(Y_prefix, usable_prefix, self.min_history_weeks)

    def _predict(self, horizons: list[int]) -> np.ndarray:
        n, T = self._H.shape
        out = np.full((n, len(horizons)), np.nan)
        for j, h in enumerate(horizons):
            lag_col = T + h - 1 - self.season_length
            if 0 <= lag_col < T:
                out[:, j] = self._H[:, lag_col]
        out[self._insuff, :] = np.nan
        return out


class NaiveDrift(BatchModel):
    """M3 — last usable value + h x mean first-difference of the usable history.

    The mean first-difference of the compressed (NaN-free) usable series
    telescopes to (last - first) / (n_valid - 1), which is what is computed.
    """

    model_id = "M3"
    min_history_weeks = 8

    def _fit(self, Y_prefix: np.ndarray, usable_prefix: np.ndarray, origin_idx: int) -> None:
        H = masked_history(Y_prefix, usable_prefix)
        n_valid = (~np.isnan(H)).sum(axis=1).astype(float)
        last = last_valid(H)
        first = first_valid(H)
        with np.errstate(divide="ignore", invalid="ignore"):
            drift = np.where(n_valid >= 2, (last - first) / np.maximum(n_valid - 1, 1), 0.0)
        insuff = insufficient_history(Y_prefix, usable_prefix, self.min_history_weeks)
        last[insuff] = np.nan
        self._last = last
        self._drift = drift

    def _predict(self, horizons: list[int]) -> np.ndarray:
        hs = np.asarray(horizons, dtype=float)
        return self._last[:, None] + hs[None, :] * self._drift[:, None]


class MovingAverage(BatchModel):
    """M4 — mean of the last n usable values, flat across horizons.

    model_id is 'M4_{n}'; min history equals the window length n.
    """

    def __init__(self, n: int) -> None:
        super().__init__()
        self.n = int(n)
        self.model_id = f"M4_{self.n}"
        self.min_history_weeks = self.n

    def _fit(self, Y_prefix: np.ndarray, usable_prefix: np.ndarray, origin_idx: int) -> None:
        H = masked_history(Y_prefix, usable_prefix)
        valid = ~np.isnan(H)
        mask = last_n_mask(valid, self.n)
        counts = mask.sum(axis=1).astype(float)
        sums = np.where(mask, H, 0.0).sum(axis=1)
        with np.errstate(divide="ignore", invalid="ignore"):
            pred = np.where(counts > 0, sums / np.maximum(counts, 1), np.nan)
        pred[insufficient_history(Y_prefix, usable_prefix, self.min_history_weeks)] = np.nan
        self._pred = pred

    def _predict(self, horizons: list[int]) -> np.ndarray:
        return _flat(self._pred, horizons)
