"""Batch-first model interface with the future-blind hard assert.

Contract:
- `fit` receives Y_prefix of shape (n_series, origin_idx) — the harness slices
  the panel matrix BEFORE the call, and `fit` asserts the widths agree, so a
  model can never see a week at or after the origin.
- `predict` returns shape (n_series, len(horizons)); horizon h means the
  week at index origin_idx + h - 1 on the full calendar.
- Models are vectorized across series. Per-series Python objects are forbidden
  except in ets.py (M10), which subsets and parallelizes explicitly.
- NaN cells in Y_prefix are weeks outside a SKU's active lifespan; models must
  tolerate them (treat as missing, not zero). Series with fewer than
  `min_history_weeks` non-NaN prefix weeks must predict NaN (the harness
  excludes NaN predictions from scoring).
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Sequence

import numpy as np


class FutureLeakError(AssertionError):
    """Raised when a model receives data at or beyond its origin."""


class BatchModel(ABC):
    model_id: str = "base"
    min_history_weeks: int = 1
    handles_intermittent: bool = False

    def __init__(self) -> None:
        self._fitted = False
        self._origin_idx: int | None = None

    def fit(self, Y_prefix: np.ndarray, usable_prefix: np.ndarray, origin_idx: int) -> None:
        """Y_prefix, usable_prefix: (n_series, origin_idx). Hard-asserts the
        prefix width equals origin_idx — the future-blind guarantee."""
        if Y_prefix.ndim != 2 or usable_prefix.shape != Y_prefix.shape:
            raise ValueError("Y_prefix and usable_prefix must be aligned 2-D arrays")
        if Y_prefix.shape[1] != origin_idx:
            raise FutureLeakError(
                f"{self.model_id}: prefix width {Y_prefix.shape[1]} != origin_idx {origin_idx} "
                "— a model must see exactly the weeks before its origin, never more"
            )
        self._origin_idx = origin_idx
        self._fit(Y_prefix, usable_prefix, origin_idx)
        self._fitted = True

    @abstractmethod
    def _fit(self, Y_prefix: np.ndarray, usable_prefix: np.ndarray, origin_idx: int) -> None: ...

    def predict(self, horizons: Sequence[int]) -> np.ndarray:
        if not self._fitted:
            raise RuntimeError(f"{self.model_id}: predict() before fit()")
        out = self._predict(list(horizons))
        return np.asarray(out, dtype=float)

    @abstractmethod
    def _predict(self, horizons: list[int]) -> np.ndarray: ...


def masked_history(Y_prefix: np.ndarray, usable_prefix: np.ndarray) -> np.ndarray:
    """Convenience: copy of Y_prefix with unusable weeks set to NaN."""
    out = Y_prefix.astype(float).copy()
    out[~usable_prefix] = np.nan
    return out


def insufficient_history(Y_prefix: np.ndarray, usable_prefix: np.ndarray, min_weeks: int) -> np.ndarray:
    """(n_series,) bool — series whose usable non-NaN history is below min_weeks."""
    valid = usable_prefix & ~np.isnan(Y_prefix)
    return valid.sum(axis=1) < min_weeks
