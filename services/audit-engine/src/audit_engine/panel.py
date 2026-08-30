"""Matrix layer: pivot the long clean panel once into aligned numpy matrices.

Everything in the model/selection layer works on these matrices — models are
batch-first array ops across all series, never per-SKU Python loops. Per-origin
work is column slicing (views); only price-derived promo tags are recomputed
per origin prefix (leakage rule).
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd


@dataclass
class PanelMatrices:
    """Aligned (n_series, n_weeks) matrices plus the series/week indexes.

    Row i in every matrix is the series `series_index.iloc[i]`; column j is
    the week `weeks[j]`. Weeks are a complete, sorted, weekly calendar spine.
    NaN in Y_corrected means the week is outside the SKU's active lifespan.
    """

    Y_corrected: np.ndarray      # float, availability-corrected winsorized units
    Y_raw: np.ndarray            # float, raw weekly units
    usable_mask: np.ndarray      # bool, week eligible for scoring/baseline
    stockout_mask: np.ndarray    # bool, week contains a High/Medium suspected stockout
    promo_mask: np.ndarray       # bool, full-sample promo tags (harness re-derives per origin)
    price: np.ndarray            # float, median selling price per week (NaN if unknown)
    weeks: pd.DatetimeIndex      # length n_weeks, sorted ascending
    series_index: pd.DataFrame   # columns: sku, location (+ segment cols merged later)

    @property
    def n_series(self) -> int:
        return self.Y_corrected.shape[0]

    @property
    def n_weeks(self) -> int:
        return self.Y_corrected.shape[1]

    def origin_idx(self, origin_date: pd.Timestamp) -> int:
        """Number of weeks strictly before origin_date; the fit prefix width."""
        return int((self.weeks < origin_date).sum())


def _pivot(panel: pd.DataFrame, col: str, index: pd.MultiIndex, weeks: pd.DatetimeIndex, fill) -> np.ndarray:
    wide = panel.pivot_table(index=["sku", "location"], columns="week_start", values=col, aggfunc="first")
    wide = wide.reindex(index=index, columns=weeks)
    if fill is not None:
        wide = wide.fillna(fill)
    return wide.to_numpy()


def build_matrices(panel: pd.DataFrame) -> PanelMatrices:
    """Pivot the long clean panel (PanelSchema) into PanelMatrices. Called once per run."""
    panel = panel.copy()
    panel["week_start"] = pd.to_datetime(panel["week_start"])
    weeks = pd.DatetimeIndex(sorted(panel["week_start"].unique()))
    index = pd.MultiIndex.from_frame(
        panel[["sku", "location"]].drop_duplicates().sort_values(["sku", "location"]).reset_index(drop=True)
    )
    conf = panel["stockout_confidence"].isin(["high", "medium"])
    panel["_hm_stockout"] = panel["stockout_flag"] & conf

    mats = PanelMatrices(
        Y_corrected=_pivot(panel, "units_corrected", index, weeks, None),
        Y_raw=_pivot(panel, "units_raw", index, weeks, None),
        usable_mask=_pivot(panel, "usable", index, weeks, False).astype(bool),
        stockout_mask=_pivot(panel, "_hm_stockout", index, weeks, False).astype(bool),
        promo_mask=_pivot(panel, "promo_flag", index, weeks, False).astype(bool),
        price=_pivot(panel, "price_median", index, weeks, None),
        weeks=weeks,
        series_index=index.to_frame(index=False),
    )
    return mats
