"""Combination models (C1/C2/C4 building blocks) and residual correlation.

Combos wrap already-constructed member BatchModel instances: ``fit`` fits
every member on the same (Y_prefix, usable_prefix, origin_idx); ``predict``
aggregates member predictions NaN-aware — a member's NaN row is simply
ignored for that series (np.nanmedian / np.nanmean semantics). A series
where every member predicts NaN stays NaN.
"""
from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from .base import BatchModel


class _ComboBase(BatchModel):
    def __init__(self, members: list[BatchModel], model_id: str) -> None:
        super().__init__()
        if not members:
            raise ValueError("combo needs at least one member")
        self.members = list(members)
        self.model_id = model_id
        self.min_history_weeks = min(m.min_history_weeks for m in self.members)

    def _fit(self, Y_prefix: np.ndarray, usable_prefix: np.ndarray, origin_idx: int) -> None:
        for m in self.members:
            m.fit(Y_prefix, usable_prefix, origin_idx)

    def _member_preds(self, horizons: list[int]) -> np.ndarray:
        """(n_members, n_series, n_horizons) stacked member predictions."""
        return np.stack([m.predict(horizons) for m in self.members], axis=0)


class MedianCombo(_ComboBase):
    """C1-style combo: elementwise NaN-aware median of member predictions."""

    def __init__(self, members: list[BatchModel], model_id: str = "C1") -> None:
        super().__init__(members, model_id)

    def _predict(self, horizons: list[int]) -> np.ndarray:
        P = self._member_preds(horizons)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN slices -> NaN
            return np.nanmedian(P, axis=0)


class MeanCombo(_ComboBase):
    """C2-style combo: elementwise NaN-aware arithmetic mean of members."""

    def __init__(self, members: list[BatchModel], model_id: str = "C2") -> None:
        super().__init__(members, model_id)

    def _predict(self, horizons: list[int]) -> np.ndarray:
        P = self._member_preds(horizons)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            return np.nanmean(P, axis=0)


class InverseErrorCombo(_ComboBase):
    """C4-style combo: fixed per-member weights (e.g. inverse rolling WAPE),
    floored at ``floor`` then renormalized to sum 1. NaN members are dropped
    per cell and the surviving weights renormalize implicitly."""

    def __init__(
        self,
        members: list[BatchModel],
        weights: np.ndarray,
        floor: float = 0.10,
        model_id: str = "C4",
    ) -> None:
        super().__init__(members, model_id)
        w = np.asarray(weights, dtype=float)
        if w.shape != (len(self.members),):
            raise ValueError("weights must be 1-D with one weight per member")
        if np.any(~np.isfinite(w)) or np.any(w < 0):
            raise ValueError("weights must be finite and non-negative")
        w = np.maximum(w, float(floor))
        self.weights = w / w.sum()
        self.floor = float(floor)

    def _predict(self, horizons: list[int]) -> np.ndarray:
        P = self._member_preds(horizons)
        w = self.weights[:, None, None]
        valid = ~np.isnan(P)
        num = np.nansum(np.where(valid, P, 0.0) * w, axis=0)
        den = (w * valid).sum(axis=0)
        with np.errstate(divide="ignore", invalid="ignore"):
            out = np.where(den > 0, num / np.where(den > 0, den, 1.0), np.nan)
        return out


class TrimmedMeanCombo(_ComboBase):
    """C3-style combo: per (series, horizon) cell, drop the single highest and
    single lowest member prediction, then average the rest — NaN-aware.

    A cell needs >= 3 non-NaN members for trimming to be meaningful (dropping
    one from each end still leaves >= 1); below that the cell falls back to a
    plain NaN-aware mean of whatever members are present. Members that predict
    NaN for a cell never participate in that cell's min/max or mean.
    """

    def __init__(self, members: list[BatchModel], model_id: str = "C3") -> None:
        super().__init__(members, model_id)

    def _predict(self, horizons: list[int]) -> np.ndarray:
        P = self._member_preds(horizons)  # (n_members, n_series, n_horizons)
        n_valid = np.sum(~np.isnan(P), axis=0)  # (n_series, n_horizons)

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN slices
            plain_mean = np.nanmean(P, axis=0)
            cell_min = np.nanmin(P, axis=0)
            cell_max = np.nanmax(P, axis=0)
            cell_sum = np.nansum(P, axis=0)

        # Trimmed mean where >= 3 non-NaN members: remove one min + one max.
        # Because np.nanmin/nanmax pick a single element each, subtracting them
        # from the sum drops exactly one lowest and one highest value even when
        # duplicates exist (the remaining duplicates stay in).
        trim_count = np.where(n_valid >= 3, n_valid - 2, np.nan)
        trimmed = (cell_sum - cell_min - cell_max) / trim_count

        out = np.where(n_valid >= 3, trimmed, plain_mean)
        # cells with zero valid members -> nanmean already produced NaN
        return out


class TwoLayerCombo(_ComboBase):
    """C6-style combo: a robust baseline member plus a clamped additive uplift
    drawn from a second member's *excess* over the baseline.

        forecast = base_pred + max(0, uplift_pred - base_pred) * w

    This is a pragmatic stand-in for a true two-layer (baseline + event) model:
    at model-comparison time there is no separate event layer, so we treat the
    amount by which a more reactive member exceeds the robust baseline as the
    "uplift" signal and add back a fraction ``w`` of it, floored at zero so the
    combo never forecasts below its baseline. NaN-aware: where the uplift member
    is NaN the forecast is just the baseline; where the baseline is NaN the cell
    is NaN.
    """

    def __init__(
        self,
        members: list[BatchModel],
        w: float = 0.5,
        model_id: str = "C6",
    ) -> None:
        if len(members) != 2:
            raise ValueError("TwoLayerCombo needs exactly two members: [base, uplift]")
        super().__init__(members, model_id)
        self.w = float(w)

    def _predict(self, horizons: list[int]) -> np.ndarray:
        P = self._member_preds(horizons)  # (2, n_series, n_horizons)
        base = P[0]
        uplift = P[1]
        excess = np.where(np.isnan(uplift), 0.0, np.maximum(0.0, uplift - base))
        return base + excess * self.w


# --------------------------------------------------------------------------- #
# Diversity-gated factory
# --------------------------------------------------------------------------- #

_KIND_TO_CLASS = {
    "median": MedianCombo,
    "mean": MeanCombo,
    "trimmed": TrimmedMeanCombo,
    "inverse_error": InverseErrorCombo,
    "two_layer": TwoLayerCombo,
}


def build_combo(
    combo_id: str,
    member_ids: list[str],
    config,
    kind: str,
    **kwargs,
) -> BatchModel:
    """Build a fresh combo of ``kind`` from ``member_ids`` via the registry.

    Members are constructed by id through ``registry._build`` (fresh instances,
    no shared state). The returned combo carries a ``.member_ids`` attribute so
    the orchestrator can later check it against the residual-correlation gate
    (which needs backtest residuals unavailable at construction time) and drop /
    report gate-failing combos. Raises whatever ``_build`` raises for an unknown
    member id — callers that want to skip gracefully should catch KeyError.

    ``kwargs`` are passed to the combo class (e.g. ``weights=`` for
    inverse_error, ``w=`` for two_layer).
    """
    from .registry import _build  # local import avoids an import cycle

    if kind not in _KIND_TO_CLASS:
        raise ValueError(f"unknown combo kind: {kind!r}")
    members = [_build(mid, config) for mid in member_ids]
    cls = _KIND_TO_CLASS[kind]

    if kind == "inverse_error" and "weights" not in kwargs:
        # sensible default: equal weights (floor+renormalize handled by class)
        kwargs["weights"] = np.ones(len(members), dtype=float)

    combo = cls(members, model_id=combo_id, **kwargs)
    combo.member_ids = list(member_ids)
    return combo


def gated_combo(
    combo_id: str,
    member_ids: list[str],
    config,
    kind: str,
    **kwargs,
) -> BatchModel:
    """Alias for :func:`build_combo` that documents intent: the residual-corr
    gate is enforced downstream by the harness/orchestrator using the combo's
    exposed ``.member_ids``, not here at construction (no residuals yet)."""
    return build_combo(combo_id, member_ids, config, kind, **kwargs)


def residual_correlation(errors: dict[str, np.ndarray]) -> pd.DataFrame:
    """Pairwise Pearson correlation of member residuals.

    ``errors`` maps model_id -> error array (any shape, all the same shape);
    arrays are flattened and correlated pairwise over cells where both are
    non-NaN (pandas pairwise-complete semantics). Feeds the SPEC 9 diversity
    gate (drop a member of any pair above residual_corr_max)."""
    flat = {k: np.asarray(v, dtype=float).ravel() for k, v in errors.items()}
    lengths = {v.size for v in flat.values()}
    if len(lengths) > 1:
        raise ValueError("all error arrays must have the same number of cells")
    return pd.DataFrame(flat).corr(method="pearson")
