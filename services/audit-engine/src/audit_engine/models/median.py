"""M5 median_winsorized — the default champion.

Window = last ``window`` usable values; each value is capped at
``cap_multiple`` x the median of that window; the forecast is the median of
the capped window, flat across horizons.

Note (documented deliberately): with non-negative demand, capping at
2 x the window's own median can never move the window's median — the cap is
always >= the median, so the middle order statistic is untouched. The capping
step is still applied exactly as specified (it matters for any downstream
consumer of the capped window and for configs with cap_multiple < 2 e.g. 1.0),
and the median remains robust to spikes by construction.
"""
from __future__ import annotations

import warnings

import numpy as np

from .base import BatchModel, insufficient_history, masked_history
from .naive import _flat, last_n_mask


class MedianWinsorized(BatchModel):
    """M5 — median of the last ``window`` usable values, winsorized at
    ``cap_multiple`` x the median of that same window."""

    model_id = "M5"

    def __init__(self, window: int = 13, cap_multiple: float = 2.0, min_history_weeks: int = 6) -> None:
        super().__init__()
        self.window = int(window)
        self.cap_multiple = float(cap_multiple)
        self.min_history_weeks = int(min_history_weeks)

    def _fit(self, Y_prefix: np.ndarray, usable_prefix: np.ndarray, origin_idx: int) -> None:
        H = masked_history(Y_prefix, usable_prefix)
        valid = ~np.isnan(H)
        mask = last_n_mask(valid, self.window)
        W = np.where(mask, H, np.nan)
        has_any = mask.any(axis=1)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN slices
            med = np.nanmedian(W, axis=1)
            cap = self.cap_multiple * med
            Wc = np.minimum(W, cap[:, None])
            pred = np.nanmedian(Wc, axis=1)
        pred[~has_any] = np.nan
        pred[insufficient_history(Y_prefix, usable_prefix, self.min_history_weeks)] = np.nan
        self._pred = pred

    def _predict(self, horizons: list[int]) -> np.ndarray:
        return _flat(self._pred, horizons)
