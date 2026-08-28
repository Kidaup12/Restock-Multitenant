"""Finding 7.6/7.7 — catalogue structure: ABC value concentration,
forecastability split, lifecycle counts."""
from __future__ import annotations

import pandas as pd

from audit_engine.config import Config

_KEYS = ["sku", "location"]
_ABC = ["A", "B", "C"]
_CLASSES = ["smooth", "intermittent", "erratic", "lumpy"]
_LIFECYCLE = ["active", "new", "dormant"]


def _trailing_52w_revenue(panel: pd.DataFrame) -> pd.DataFrame:
    max_week = panel["week_start"].max()
    recent = panel if pd.isna(max_week) else panel[
        panel["week_start"] >= max_week - pd.Timedelta(weeks=51)
    ]
    recent = recent.assign(rev=(recent["units_raw"] * recent["price_median"]).fillna(0.0))
    return recent.groupby(_KEYS, as_index=False)["rev"].sum().rename(columns={"rev": "revenue"})


def catalogue_structure(segments: pd.DataFrame, panel: pd.DataFrame,
                        config: Config) -> dict:
    """ABC revenue concentration (incl. top-10-SKU share), forecastability
    split by catalogue count AND revenue, lifecycle counts."""
    seg = segments.merge(_trailing_52w_revenue(panel), on=_KEYS, how="left")
    seg["revenue"] = seg["revenue"].fillna(0.0)
    n = int(len(seg))
    total_rev = float(seg["revenue"].sum())

    def _share(x: float, total: float) -> float:
        return float(x) / total if total > 0 else 0.0

    def _group(col: str, values: list[str]) -> dict:
        out = {}
        for v in values:
            sub = seg[seg[col] == v]
            rev = float(sub["revenue"].sum())
            out[v] = {
                "n_skus": int(len(sub)),
                "count_share": _share(len(sub), n),
                "revenue": rev,
                "revenue_share": _share(rev, total_rev),
            }
        return out

    top10_share = _share(float(seg["revenue"].nlargest(10).sum()), total_rev)
    lifecycle = seg["lifecycle"].value_counts().to_dict() if "lifecycle" in seg.columns else {}

    return {
        "n_skus": n,
        "total_revenue_52w": total_rev,
        "abc": _group("abc", _ABC),
        "top10_revenue_share": top10_share,
        "forecastability": _group("demand_class", _CLASSES),
        "lifecycle": {k: int(lifecycle.get(k, 0)) for k in _LIFECYCLE},
    }
