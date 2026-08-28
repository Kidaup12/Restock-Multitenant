"""Robust baseline — a defensible "normal week", not a forecast (SPEC §6).

Per SKU-location: take the trailing ``baseline.window_weeks`` (13) weeks of
availability-corrected weekly rates as of ``as_of`` (default: last panel
week), drop weeks that are unusable or tagged promo/bulk, winsorize the
remaining set at ``winsorize_multiple`` × the median of the set, and take the
configured statistic (median by default).

Fallback ladder (SPEC §6):

==========================  ================================================
< 4 weeks since launch      method 'launch', baseline NaN (launch burst is
                            not demand), confidence 'not_assessable'
no sale in dormancy_weeks   method 'dormant', baseline NaN, route to dead
                            stock findings, confidence 'not_assessable'
>= window_weeks usable      method 'own', confidence 'high'
min_usable..window-1 usable method 'own', confidence 'low'
< min_usable usable         method 'cluster_analog': median of same-category
                            'own' baselines if a category_map is given, else
                            global median of 'own' baselines; confidence 'low'
==========================  ================================================

Only trailing data as of ``as_of`` is ever used — no full-sample statistics.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from audit_engine.schemas import BaselineSchema

# SPEC §6: "< 4 weeks since launch → Not assessable". Not in defaults.yaml.
LAUNCH_MIN_WEEKS = 4


def compute_baseline(
    panel: pd.DataFrame,
    config,
    category_map: dict[str, str] | None = None,
    as_of: pd.Timestamp | None = None,
) -> pd.DataFrame:
    """Compute per SKU-location baselines from the clean panel (PanelSchema).

    Returns a BaselineSchema-validated frame with one row per SKU-location
    present in the panel at or before ``as_of``.
    """
    bcfg = config.baseline
    dormancy_days = 7 * config.segments.dormancy_weeks

    df = panel.loc[
        :,
        ["sku", "location", "week_start", "units_raw", "units_corrected",
         "promo_flag", "bulk_flag", "usable"],
    ].copy()
    df["week_start"] = pd.to_datetime(df["week_start"])
    if as_of is None:
        as_of = df["week_start"].max()
    as_of = pd.Timestamp(as_of)
    df = df[df["week_start"] <= as_of]
    window_lo = as_of - pd.Timedelta(days=7 * bcfg.window_weeks)  # exclusive lower bound

    records: list[dict] = []
    for (sku, loc), g in df.groupby(["sku", "location"], sort=True):
        first_week = g["week_start"].min()
        history_weeks = (as_of - first_week).days // 7 + 1
        sold = g.loc[g["units_raw"] > 0, "week_start"]
        last_sale = sold.max() if not sold.empty else pd.NaT

        window = g[g["week_start"] > window_lo]
        usable = window[window["usable"] & ~window["promo_flag"] & ~window["bulk_flag"]]
        vals = usable["units_corrected"].to_numpy(dtype=float)
        vals = vals[~np.isnan(vals)]
        n = int(vals.size)

        rec: dict = {"sku": sku, "location": loc, "usable_weeks": n}
        if history_weeks < LAUNCH_MIN_WEEKS:
            rec.update(baseline_weekly=np.nan, method="launch", confidence="not_assessable")
        elif pd.isna(last_sale) or (as_of - last_sale).days >= dormancy_days:
            rec.update(baseline_weekly=np.nan, method="dormant", confidence="not_assessable")
        elif n >= bcfg.min_usable_weeks:
            med = float(np.median(vals))
            cap = bcfg.winsorize_multiple * med
            winsorized = np.minimum(vals, cap)
            if bcfg.statistic == "mean":
                stat = float(np.mean(winsorized))
            else:  # 'median' (default)
                stat = float(np.median(winsorized))
            conf = "high" if n >= bcfg.window_weeks else "low"
            rec.update(baseline_weekly=stat, method="own", confidence=conf)
        else:
            # resolved against 'own' baselines in the second pass below
            rec.update(baseline_weekly=np.nan, method="cluster_analog", confidence="low")
        records.append(rec)

    out = pd.DataFrame(records)
    if out.empty:
        out = pd.DataFrame(
            columns=["sku", "location", "baseline_weekly", "baseline_daily",
                     "usable_weeks", "method", "confidence"]
        ).astype({"usable_weeks": int})
        return BaselineSchema.validate(out)

    # --- cluster-analog second pass ----------------------------------------
    own = out[out["method"] == "own"]
    analog_idx = out.index[out["method"] == "cluster_analog"]
    if len(analog_idx) > 0:
        global_median = float(own["baseline_weekly"].median()) if not own.empty else np.nan
        for idx in analog_idx:
            val = np.nan
            if category_map:
                cat = category_map.get(out.at[idx, "sku"])
                if cat is not None and not own.empty:
                    peers = own[own["sku"].map(category_map) == cat]
                    if not peers.empty:
                        val = float(peers["baseline_weekly"].median())
            if np.isnan(val):
                val = global_median
            out.at[idx, "baseline_weekly"] = val

    out["baseline_daily"] = out["baseline_weekly"] / 7.0
    out = out[["sku", "location", "baseline_weekly", "baseline_daily",
               "usable_weeks", "method", "confidence"]]
    return BaselineSchema.validate(out)
