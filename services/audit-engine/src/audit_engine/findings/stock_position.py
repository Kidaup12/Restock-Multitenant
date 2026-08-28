"""Findings 7.3-7.5 — cover buckets, dead stock, imminent runouts, capital.

weeks_of_cover = qty_on_hand / baseline_weekly, inf-safe: a NaN or zero
baseline yields NaN cover and the SKU is bucketed by lifecycle instead
(dormant + stock -> Dead, else Not assessable).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from audit_engine.config import Config

_KEYS = ["sku", "location"]

# SPEC §7.4 fixed band edges not present in config (config owns 12 / 26).
HEALTHY_MIN_WEEKS = 4.0
THIN_MIN_WEEKS = 1.0

BUCKET_ORDER = [
    "Severe overstock", "Overstock", "Healthy", "Thin",
    "Imminent runout", "Dead", "Not assessable",
]

COVER_COLS = _KEYS + [
    "qty_on_hand", "unit_cost", "stock_value", "baseline_weekly",
    "weeks_of_cover", "bucket", "abc", "lifecycle",
]
DEAD_COLS = _KEYS + ["qty_on_hand", "unit_cost", "weeks_since_sale", "bucket", "value"]
RUNOUT_COLS = _KEYS + ["qty_on_hand", "baseline_weekly", "weeks_of_cover", "bucket"]


def _dead_bucket_labels(w: list[int]) -> tuple[str, str, str]:
    # [8, 13, 26] -> ("8-12w", "13-26w", "26w+")
    return (f"{w[0]}-{w[1] - 1}w", f"{w[1]}-{w[2]}w", f"{w[2]}w+")


def stock_position(stock: pd.DataFrame, baseline: pd.DataFrame,
                   panel: pd.DataFrame, segments: pd.DataFrame,
                   config: Config) -> dict:
    """Returns {'cover', 'cover_buckets', 'dead_stock', 'runouts', 'capital'}."""
    lo, hi = (float(x) for x in config.findings.overstock_cover_weeks[:2])
    w_dead = [int(x) for x in config.findings.dead_stock_weeks]
    lbl_1, lbl_2, lbl_3 = _dead_bucket_labels(w_dead)

    df = stock.copy()
    if "unit_cost" not in df.columns:
        df["unit_cost"] = np.nan
    bl_cols = [c for c in ("baseline_weekly", "method") if c in baseline.columns]
    df = df.merge(baseline[_KEYS + bl_cols], on=_KEYS, how="left")
    for c in ("baseline_weekly", "method"):
        if c not in df.columns:
            df[c] = np.nan
    seg_cols = [c for c in ("abc", "lifecycle") if c in segments.columns]
    df = df.merge(segments[_KEYS + seg_cols], on=_KEYS, how="left")
    for c in ("abc", "lifecycle"):
        if c not in df.columns:
            df[c] = np.nan

    bw = df["baseline_weekly"].where(df["baseline_weekly"] > 0)
    df["weeks_of_cover"] = df["qty_on_hand"] / bw
    df["stock_value"] = df["qty_on_hand"] * df["unit_cost"]

    def _bucket(r) -> str:
        dormant = (r["lifecycle"] == "dormant") or (r["method"] == "dormant")
        if dormant:
            return "Dead" if r["qty_on_hand"] > 0 else "Not assessable"
        c = r["weeks_of_cover"]
        if pd.isna(c):
            return "Not assessable"
        if c > hi:
            return "Severe overstock"
        if c >= lo:
            return "Overstock"
        if c >= HEALTHY_MIN_WEEKS:
            return "Healthy"
        if c >= THIN_MIN_WEEKS:
            return "Thin"
        return "Imminent runout"

    df["bucket"] = df.apply(_bucket, axis=1) if len(df) else pd.Series(dtype=str)
    cover = df.reindex(columns=COVER_COLS).reset_index(drop=True)

    cover_buckets = (
        cover.groupby("bucket")
        .agg(n_skus=("bucket", "size"), units=("qty_on_hand", "sum"),
             value=("stock_value", "sum"))
        .reindex(BUCKET_ORDER)
    )
    cover_buckets[["n_skus", "units"]] = cover_buckets[["n_skus", "units"]].fillna(0)
    cover_buckets["value"] = cover_buckets["value"].fillna(0.0)
    cover_buckets = cover_buckets.astype({"n_skus": int}).reset_index(names="bucket")

    # --- dead stock: last-sale age >= dead_stock_weeks[0] and stock on hand ---
    sold = (
        panel.loc[panel["units_raw"] > 0]
        .groupby(_KEYS)["week_start"].max().rename("last_sale_week")
    )
    first_week = panel.groupby(_KEYS)["week_start"].min().rename("first_week")
    max_week = panel["week_start"].max()
    d = cover.merge(sold, on=_KEYS, how="left").merge(first_week, on=_KEYS, how="left")
    age_sold = (max_week - d["last_sale_week"]).dt.days / 7.0
    age_never = (max_week - d["first_week"]).dt.days / 7.0   # never sold: whole history span
    d["weeks_since_sale"] = age_sold.where(d["last_sale_week"].notna(), age_never)
    dead_mask = (
        d["first_week"].notna()                     # only SKUs we can see history for
        & (d["qty_on_hand"] > 0)
        & (d["weeks_since_sale"] >= w_dead[0])
    )
    dead = d.loc[dead_mask].copy()

    def _dbucket(age: float) -> str:
        if age < w_dead[1]:
            return lbl_1
        if age < w_dead[2]:
            return lbl_2
        return lbl_3

    dead["bucket"] = dead["weeks_since_sale"].map(_dbucket)
    dead["value"] = dead["qty_on_hand"] * dead["unit_cost"]   # NaN cost -> NaN value
    dead_stock = (
        dead.reindex(columns=DEAD_COLS)
        .sort_values("value", ascending=False, na_position="last")
        .reset_index(drop=True)
    )

    # --- imminent runouts: A-class with cover below the runout threshold ------
    run_mask = (cover["abc"] == "A") & (
        cover["weeks_of_cover"] < float(config.findings.runout_cover_weeks)
    )
    runouts = (
        cover.loc[run_mask]
        .reindex(columns=RUNOUT_COLS)
        .sort_values("weeks_of_cover")
        .reset_index(drop=True)
    )

    # --- capital -------------------------------------------------------------
    over_mask = cover["bucket"].isin(["Overstock", "Severe overstock"])
    dead_val_by_bucket = {
        lbl: float(dead_stock.loc[dead_stock["bucket"] == lbl, "value"].sum())
        for lbl in (lbl_1, lbl_2, lbl_3)
    }
    dead_units_by_bucket = {
        lbl: float(dead_stock.loc[dead_stock["bucket"] == lbl, "qty_on_hand"].sum())
        for lbl in (lbl_1, lbl_2, lbl_3)
    }
    capital = {
        "total_stock_value": float(cover["stock_value"].sum()),
        "overstock_value": float(cover.loc[over_mask, "stock_value"].sum()),
        "dead_stock_value": float(dead_stock["value"].sum()),
        "dead_stock_units": float(dead_stock["qty_on_hand"].sum()),
        "dead_value_by_bucket": dead_val_by_bucket,
        "dead_units_by_bucket": dead_units_by_bucket,
        "uncosted_units": float(
            cover.loc[cover["unit_cost"].isna() & (cover["qty_on_hand"] > 0), "qty_on_hand"].sum()
        ),
    }
    return {
        "cover": cover,
        "cover_buckets": cover_buckets,
        "dead_stock": dead_stock,
        "runouts": runouts,
        "capital": capital,
    }
