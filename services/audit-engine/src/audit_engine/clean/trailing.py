"""Trailing-window helpers — the ONLY module in the codebase allowed to compute
rolling statistics.

Every statistic here is strictly past-only: the value at position t is computed
exclusively from positions < t (shift before rolling). Full-sample statistics
are the most common source of self-flattering results, so no helper in this
module ever looks at position t or later when computing the value for t.

All helpers are NaN-aware: NaN inputs are ignored inside the window; a window
with no non-NaN values yields NaN.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

__all__ = ["trailing_median", "trailing_median_df", "trailing_winsorize"]


def trailing_median(values: np.ndarray, window: int) -> np.ndarray:
    """Past-only rolling median of a 1-D array.

    Position t gets the median of ``values[max(0, t - window) : t]`` (NaN
    ignored). Position 0 is always NaN — there is no past to summarise.
    """
    s = pd.Series(np.asarray(values, dtype=float))
    out = s.shift(1).rolling(window, min_periods=1).median()
    return out.to_numpy(dtype=float)


def trailing_median_df(
    df: pd.DataFrame,
    group_cols: list[str],
    value_col: str,
    window: int,
    sort_col: str | None = None,
) -> pd.Series:
    """Per-group past-only trailing median, aligned to ``df.index``.

    Rows must be in time order within each group; pass ``sort_col`` (e.g.
    ``"week_start"``) to have the ordering enforced here. The first row of
    each group is always NaN.
    """
    work = (
        df.sort_values(list(group_cols) + [sort_col], kind="stable")
        if sort_col is not None
        else df
    )
    out = work.groupby(list(group_cols), sort=False)[value_col].transform(
        lambda s: s.shift(1).rolling(window, min_periods=1).median()
    )
    return out.reindex(df.index)


def trailing_winsorize(
    values: np.ndarray,
    window: int,
    multiple: float,
    skip_mask: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Iterative past-only winsorization of a 1-D series.

    Walks the series in time order. At each position t the trailing median is
    taken over the *working* (already-capped) values in ``[t - window, t)``,
    excluding NaN cells and cells marked in ``skip_mask`` (promo / bulk weeks
    are event-tagged and must not inflate or receive the cap). If the value at
    t exceeds ``multiple * trailing_median`` it is capped to exactly that.

    Because each position's window only ever contains final (already
    processed) values, applying this function to its own output is a no-op —
    the step is idempotent — and it never increases a value.

    A trailing median of 0 produces no cap (capping restart demand to zero
    would destroy real signal); the level-shift step handles sustained
    regime changes.

    Returns ``(capped_values, capped_flag)``.
    """
    vals = np.asarray(values, dtype=float).copy()
    n = vals.shape[0]
    capped = np.zeros(n, dtype=bool)
    if skip_mask is None:
        skip = np.zeros(n, dtype=bool)
    else:
        skip = np.asarray(skip_mask, dtype=bool)
    for t in range(n):
        if skip[t] or np.isnan(vals[t]):
            continue
        lo = max(0, t - window)
        past = vals[lo:t]
        past = past[~np.isnan(past) & ~skip[lo:t]]
        if past.size == 0:
            continue
        med = float(np.median(past))
        if med <= 0:
            continue
        cap = multiple * med
        if vals[t] > cap:
            vals[t] = cap
            capped[t] = True
    return vals, capped
