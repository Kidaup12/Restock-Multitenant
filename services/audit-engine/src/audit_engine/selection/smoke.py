"""Leakage smoke tests (SPEC §10) — run continuously, not once.

* shuffle_test: permute every series' target values across time and rerun the
  backtest. Any model still beating the naive floor after the shuffle is
  reading the future (or memorizing it) — the caller asserts all models
  collapse to ~floor level.
* horizon_monotonicity: error must worsen (or at least not improve) as the
  horizon grows; an inverted profile is a classic leakage signature.
"""
from __future__ import annotations

from dataclasses import replace
from typing import Callable

import numpy as np
import pandas as pd

from ..models.base import BatchModel
from ..panel import PanelMatrices
from .harness import run_backtest
from .scoring import _wape_by, _with_terms

__all__ = ["shuffle_test", "horizon_monotonicity"]


def shuffle_test(
    mats: PanelMatrices,
    roster_factory: Callable[[], dict[str, BatchModel]],
    config,
    seed: int = 0,
) -> pd.DataFrame:
    """Permute each series' values across time (independently per row) and run
    a small selection-block backtest on the shuffled panel.

    Returns per-model WAPE table (model_id, wape, n_scored). The caller
    asserts every model scores ≈ the naive floor: temporal structure is gone,
    so any residual skill means leakage.
    """
    rng = np.random.default_rng(seed)
    Y = mats.Y_corrected.copy()
    for i in range(Y.shape[0]):
        Y[i, :] = rng.permutation(Y[i, :])
    shuffled = replace(mats, Y_corrected=Y)

    result = run_backtest(shuffled, roster_factory, config, blocks=("selection",))
    s = _with_terms(result.scores)
    if s.empty:
        return pd.DataFrame(columns=["model_id", "wape", "n_scored"])
    out = _wape_by(s, ["model_id"])
    out = out.merge(
        s.groupby("model_id").size().rename("n_scored").reset_index(), on="model_id"
    )
    return out


def horizon_monotonicity(scores: pd.DataFrame, tolerance: float = 0.02) -> pd.DataFrame:
    """Per-model WAPE by horizon plus a monotone_nondecreasing flag.

    Flag is True when WAPE at each longer horizon is no better than the
    previous horizon's WAPE beyond a small tolerance (default 2% relative):
    wape[h+1] >= wape[h] * (1 - tolerance) for every consecutive pair.
    False flags a suspicious profile — error should not shrink with distance.
    """
    s = _with_terms(scores)
    if s.empty:
        return pd.DataFrame(columns=["model_id", "horizon", "wape", "monotone_nondecreasing"])
    by_h = _wape_by(s, ["model_id", "horizon"]).sort_values(["model_id", "horizon"])
    flags: dict[str, bool] = {}
    for model_id, grp in by_h.groupby("model_id", sort=True):
        w = grp["wape"].to_numpy(dtype=float)
        w = w[np.isfinite(w)]
        if len(w) < 2:
            flags[model_id] = True
            continue
        flags[model_id] = bool(np.all(w[1:] >= w[:-1] * (1.0 - tolerance)))
    by_h["monotone_nondecreasing"] = by_h["model_id"].map(flags)
    return by_h.reset_index(drop=True)
