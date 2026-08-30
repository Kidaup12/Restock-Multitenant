"""Finding 7.1/7.2 — lost sales from stockouts, and repeat offenders.

Money figures use High + Medium confidence episodes only (SPEC §5, §7.1).
The band is: low = High-tier only; high = High + Medium plus an allowance for
the not-assessable bucket, scaled by that bucket's share of trailing-52-week
revenue. Every output is an estimate presented as a range — never a point.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from audit_engine.config import Config

_MONEY_TIERS = ("high", "medium")
_KEYS = ["sku", "location"]

BY_SKU_COLS = [
    "sku", "location", "stockout_days", "episodes",
    "lost_units_low", "lost_units_high",
    "lost_revenue_low", "lost_revenue_high", "confidence",
]
BY_MONTH_COLS = [
    "month", "lost_units_low", "lost_units_high",
    "lost_revenue_low", "lost_revenue_high",
]
OFFENDER_COLS = ["sku", "location", "episodes", "total_days", "est_lost_revenue"]


def _median_price(panel: pd.DataFrame) -> pd.DataFrame:
    """Median selling price per SKU x location from the panel's weekly medians."""
    return (
        panel.groupby(_KEYS, as_index=False)["price_median"]
        .median()
        .rename(columns={"price_median": "price"})
    )


def _trailing_52w(panel: pd.DataFrame) -> pd.DataFrame:
    max_week = panel["week_start"].max()
    if pd.isna(max_week):
        return panel.iloc[0:0]
    cutoff = max_week - pd.Timedelta(weeks=51)
    return panel[panel["week_start"] >= cutoff]


def not_assessable_value_share(baseline: pd.DataFrame, panel: pd.DataFrame,
                               config: Config) -> float:
    """Share of trailing-52w revenue (units_raw x price_median) held by SKUs
    whose stockout inference is unavailable (baseline daily rate below the
    velocity gate, or no baseline at all)."""
    recent = _trailing_52w(panel).copy()
    if recent.empty:
        return 0.0
    recent["rev"] = (recent["units_raw"] * recent["price_median"]).fillna(0.0)
    rev = recent.groupby(_KEYS)["rev"].sum()
    total = float(rev.sum())
    if not np.isfinite(total) or total <= 0:
        return 0.0
    bd = baseline.set_index(_KEYS)["baseline_daily"]
    min_vel = float(config.availability.min_velocity_per_day)
    na_keys = set(bd.index[bd.isna() | (bd < min_vel)])
    # SKUs selling but absent from the baseline table are not assessable either.
    known = set(bd.index)
    na_rev = float(sum(v for k, v in rev.items() if (k in na_keys) or (k not in known)))
    return na_rev / total


def lost_sales(episodes: pd.DataFrame, baseline: pd.DataFrame,
               panel: pd.DataFrame, config: Config) -> dict:
    """Headline finding. Returns {'by_sku': df, 'by_month': df, 'total': dict}.

    lost_units = baseline_daily * stockout_days over High+Medium episodes.
    Band: low = High only; high = (High+Medium) * (1 + not-assessable value share).
    """
    eps = episodes.copy() if episodes is not None else pd.DataFrame(columns=_KEYS + ["days", "confidence"])
    if not eps.empty:
        eps["confidence"] = eps["confidence"].astype(str).str.lower()
    share = not_assessable_value_share(baseline, panel, config)
    n_low = int((eps["confidence"] == "low").sum()) if not eps.empty else 0

    hm = eps[eps["confidence"].isin(_MONEY_TIERS)].copy() if not eps.empty else eps
    if hm.empty:
        return {
            "by_sku": pd.DataFrame(columns=BY_SKU_COLS),
            "by_month": pd.DataFrame(columns=BY_MONTH_COLS),
            "total": {
                "units_low": 0.0, "units_high": 0.0,
                "revenue_low": 0.0, "revenue_high": 0.0,
                "not_assessable_value_share": share,
                "episodes": 0, "low_confidence_episodes": n_low,
            },
        }

    hm = hm.merge(baseline[_KEYS + ["baseline_daily"]], on=_KEYS, how="left")
    hm = hm.merge(_median_price(panel), on=_KEYS, how="left")
    hm["baseline_daily"] = hm["baseline_daily"].fillna(0.0)
    hm["lost_units_ep"] = hm["baseline_daily"] * hm["days"]
    hm["lost_units_ep_low"] = np.where(hm["confidence"] == "high", hm["lost_units_ep"], 0.0)

    by_sku = (
        hm.groupby(_KEYS)
        .agg(
            stockout_days=("days", "sum"),
            episodes=("days", "size"),
            lost_units_low=("lost_units_ep_low", "sum"),
            lost_units_high=("lost_units_ep", "sum"),
            price=("price", "first"),
            confidence=("confidence", lambda s: "high" if (s == "high").any() else "medium"),
        )
        .reset_index()
    )
    by_sku["lost_revenue_low"] = by_sku["lost_units_low"] * by_sku["price"]
    by_sku["lost_revenue_high"] = by_sku["lost_units_high"] * by_sku["price"]
    by_sku = (
        by_sku[BY_SKU_COLS]
        .sort_values("lost_revenue_high", ascending=False, na_position="last")
        .reset_index(drop=True)
    )

    # --- by month: distribute each episode's days over the months it spans ---
    rows: list[dict] = []
    for ep in hm.itertuples(index=False):
        span = pd.date_range(ep.start_date, ep.end_date, freq="D")
        if len(span) == 0:
            continue
        factor = float(ep.days) / len(span)   # respect the recorded day count
        counts = pd.Series(span).dt.to_period("M").value_counts()
        for period, n in counts.items():
            units = ep.baseline_daily * n * factor
            rev = units * ep.price
            is_high = ep.confidence == "high"
            rows.append({
                "month": str(period),
                "u_low": units if is_high else 0.0,
                "u_hm": units,
                "r_low": rev if is_high else 0.0,
                "r_hm": rev,
            })
    bm = pd.DataFrame(rows).groupby("month", as_index=False).sum().sort_values("month")
    by_month = pd.DataFrame({
        "month": bm["month"],
        "lost_units_low": bm["u_low"],
        "lost_units_high": bm["u_hm"] * (1.0 + share),
        "lost_revenue_low": bm["r_low"],
        "lost_revenue_high": bm["r_hm"] * (1.0 + share),
    }).reset_index(drop=True)

    units_low = float(by_sku["lost_units_low"].sum())
    units_hm = float(by_sku["lost_units_high"].sum())
    rev_low = float(by_sku["lost_revenue_low"].sum())        # skipna: no-price SKUs count units only
    rev_hm = float(by_sku["lost_revenue_high"].sum())
    total = {
        "units_low": units_low,
        "units_high": units_hm * (1.0 + share),
        "revenue_low": rev_low,
        "revenue_high": rev_hm * (1.0 + share),
        "not_assessable_value_share": share,
        "episodes": int(len(hm)),
        "low_confidence_episodes": n_low,
    }
    return {"by_sku": by_sku, "by_month": by_month, "total": total}


def repeat_offenders(episodes: pd.DataFrame, config: Config,
                     baseline: pd.DataFrame | None = None,
                     panel: pd.DataFrame | None = None) -> pd.DataFrame:
    """SKUs with >= repeat_offender_episodes stockout episodes in the window.

    Episode counts include Low-confidence episodes (they count, they just don't
    monetise — SPEC §5). Estimated lost revenue uses High+Medium episodes only
    and requires `baseline` and `panel`; otherwise it is NaN.
    """
    if episodes is None or len(episodes) == 0:
        return pd.DataFrame(columns=OFFENDER_COLS)
    eps = episodes.copy()
    eps["confidence"] = eps["confidence"].astype(str).str.lower()
    g = (
        eps.groupby(_KEYS)
        .agg(episodes=("days", "size"), total_days=("days", "sum"))
        .reset_index()
    )
    off = g[g["episodes"] >= int(config.findings.repeat_offender_episodes)].copy()
    off["est_lost_revenue"] = np.nan
    if baseline is not None and panel is not None and not off.empty:
        hm = eps[eps["confidence"].isin(_MONEY_TIERS)].copy()
        if not hm.empty:
            hm = hm.merge(baseline[_KEYS + ["baseline_daily"]], on=_KEYS, how="left")
            hm = hm.merge(_median_price(panel), on=_KEYS, how="left")
            hm["rev"] = hm["days"] * hm["baseline_daily"] * hm["price"]
            rev = hm.groupby(_KEYS)["rev"].sum(min_count=1).rename("est_lost_revenue").reset_index()
            off = off.drop(columns=["est_lost_revenue"]).merge(rev, on=_KEYS, how="left")
    return (
        off[OFFENDER_COLS]
        .sort_values(["episodes", "total_days"], ascending=False)
        .reset_index(drop=True)
    )
