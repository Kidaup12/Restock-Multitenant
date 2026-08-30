"""Finding 7.10 - Management playbook: per-SKU action rule from ABC x XYZ x lifecycle.

This is the professional demand-planning move: before any forecast runs, a rule
decides HOW each SKU is handled based on three axes the engine already computes:

  - ABC  (value class)        -> how much attention/capital it deserves
  - XYZ  (steadiness, CV^2)   -> whether it is forecastable or must be buffered
  - lifecycle (new/active/dormant) + intermittent_flag -> which way it is moving

The output is a routing table (each SKU -> an action + a forecasting stance) and
a summary of how the catalogue splits across the actions. It uses NO data beyond
the segments table, so it works today on sales-only history. Reorder points and
safety stock (the natural next layer) need the stock file and are noted, not
computed here.
"""
from __future__ import annotations

import pandas as pd

from audit_engine.config import Config

_KEYS = ["sku", "location"]

# action -> (short label, planning stance)
ACTIONS = {
    "forecast_review": "Forecast + human review",
    "forecast_buffer": "Forecast + heavy safety stock",
    "forecast_auto": "Forecast on autopilot",
    "pool_rule": "Pool by category + reorder rule",
    "buffer_rule": "Reorder point + safety stock (don't forecast weekly)",
    "launch_watch": "Launch curve + watch closely",
    "run_down": "Run down / write-off decision",
    "no_action": "No forecast (dead / no history)",
}


def _rule(row) -> tuple[str, str]:
    """Return (action_key, one-line why) for a single SKU. Order matters:
    lifecycle overrides, then value x steadiness."""
    abc = row["abc"]
    xyz = row["xyz"]
    life = row["lifecycle"]
    intermittent = bool(row["intermittent_flag"])

    # --- lifecycle overrides first ---
    if life == "dormant":
        return "run_down", "No recent sales - discount or write off, don't reorder"
    if life == "new":
        return "launch_watch", "Too new to forecast - use a launch curve, watch weekly"

    # --- intermittent / lumpy: rules not forecasts ---
    if intermittent or xyz == "Z":
        if abc == "A":
            return "buffer_rule", "High value but erratic - the costliest stockout; buffer heavily"
        return "pool_rule", "Erratic low/mid value - pool by category, forecast the group, split by share"

    # --- steady, forecastable items, by value ---
    if abc == "A":
        if xyz == "X":
            return "forecast_review", "High value, steady - forecast tightly, human review, thin buffer"
        return "forecast_buffer", "High value, variable - forecast but hold safety stock"
    if abc == "B":
        return "forecast_auto", "Mid value, steady - forecast on autopilot, periodic top-up"
    # C, steady
    return "pool_rule", "Low value, steady - cheap forecast or pool; minimal attention"


def _stance(action: str) -> str:
    if action in ("forecast_review", "forecast_buffer", "forecast_auto"):
        return "forecast"
    if action in ("buffer_rule", "pool_rule"):
        return "rule"
    if action == "launch_watch":
        return "launch"
    return "none"


def playbook(segments: pd.DataFrame, panel: pd.DataFrame, config: Config) -> dict:
    """Per-SKU action routing + summary. Returns:
    {
      "per_sku": DataFrame(sku, location, abc, xyz, lifecycle, intermittent_flag,
                           action, stance, action_label, why, revenue_52w),
      "by_action": DataFrame(action, action_label, n_skus, revenue_52w, revenue_share),
      "a_breakout": DataFrame(cell, n_skus, revenue_52w) for A-items by XYZ x lifecycle,
      "recommended_model": str,   # engine's default forecasting model for the forecast tier
    }
    """
    seg = segments.copy()
    for col, default in (("abc", "C"), ("xyz", "Z"), ("lifecycle", "active"),
                         ("intermittent_flag", False)):
        if col not in seg.columns:
            seg[col] = default

    # trailing 52w revenue per SKU (value weighting for the summary)
    max_week = panel["week_start"].max()
    recent = panel if pd.isna(max_week) else panel[
        panel["week_start"] >= max_week - pd.Timedelta(weeks=51)
    ]
    rev = (recent.assign(rev=(recent["units_raw"] * recent["price_median"]).fillna(0.0))
           .groupby(_KEYS, as_index=False)["rev"].sum()
           .rename(columns={"rev": "revenue_52w"}))

    rows = seg.apply(lambda r: pd.Series(_rule(r), index=["action", "why"]), axis=1)
    per = pd.concat([seg[_KEYS + ["abc", "xyz", "lifecycle", "intermittent_flag"]], rows], axis=1)
    per = per.merge(rev, on=_KEYS, how="left")
    per["revenue_52w"] = per["revenue_52w"].fillna(0.0)
    per["stance"] = per["action"].map(_stance)
    per["action_label"] = per["action"].map(ACTIONS)

    total_rev = per["revenue_52w"].sum()
    by_action = (per.groupby("action", as_index=False)
                 .agg(n_skus=("sku", "nunique"), revenue_52w=("revenue_52w", "sum")))
    by_action["action_label"] = by_action["action"].map(ACTIONS)
    by_action["revenue_share"] = (by_action["revenue_52w"] / total_rev) if total_rev else 0.0
    by_action = by_action.sort_values("revenue_52w", ascending=False).reset_index(drop=True)

    # A-item breakout by XYZ x lifecycle (the tier pros actually forecast)
    a = per[per["abc"] == "A"].copy()
    a["cell"] = a["xyz"] + " / " + a["lifecycle"]
    a_breakout = (a.groupby("cell", as_index=False)
                  .agg(n_skus=("sku", "nunique"), revenue_52w=("revenue_52w", "sum"))
                  .sort_values("revenue_52w", ascending=False).reset_index(drop=True))

    return {
        "per_sku": per,
        "by_action": by_action,
        "a_breakout": a_breakout,
        "recommended_model": config.models.default_champion,
    }
