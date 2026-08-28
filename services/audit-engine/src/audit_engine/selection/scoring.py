"""Scoring metrics for the selection harness (SPEC §10).

WAPE is the primary metric; signed bias is reported separately, never buried.
MAPE is deliberately absent. Every result can be expressed as % better than
the naive floor via `pct_vs_floor`.

Only rows with ``scored == True`` participate in any aggregate here; the
harness marks censored / unusable / insufficient-history rows unscored.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

__all__ = ["wape", "signed_bias_pct", "score_frame", "pct_vs_floor"]


def wape(y_true, y_pred) -> float:
    """Sum |y - yhat| / Sum |y| over pairs where both are finite. NaN if no
    valid pairs or the denominator is zero."""
    yt = np.asarray(y_true, dtype=float).ravel()
    yp = np.asarray(y_pred, dtype=float).ravel()
    mask = np.isfinite(yt) & np.isfinite(yp)
    if not mask.any():
        return float("nan")
    denom = np.abs(yt[mask]).sum()
    if denom == 0:
        return float("nan")
    return float(np.abs(yt[mask] - yp[mask]).sum() / denom)


def signed_bias_pct(y_true, y_pred) -> float:
    """Sum (yhat - y) / Sum y * 100 over finite pairs. Positive = over-forecast.
    Under stockout censoring expect this negative across all models (SPEC §10)."""
    yt = np.asarray(y_true, dtype=float).ravel()
    yp = np.asarray(y_pred, dtype=float).ravel()
    mask = np.isfinite(yt) & np.isfinite(yp)
    if not mask.any():
        return float("nan")
    denom = yt[mask].sum()
    if denom == 0:
        return float("nan")
    return float((yp[mask] - yt[mask]).sum() / denom * 100.0)


def _with_terms(scores: pd.DataFrame) -> pd.DataFrame:
    s = scores.loc[scores["scored"].astype(bool)].copy()
    s = s.loc[np.isfinite(s["y_true"].astype(float)) & np.isfinite(s["y_pred"].astype(float))]
    s["_ae"] = (s["y_true"] - s["y_pred"]).abs()
    s["_ay"] = s["y_true"].abs()
    s["_err"] = s["y_pred"] - s["y_true"]
    return s


def _wape_by(s: pd.DataFrame, keys: list[str]) -> pd.DataFrame:
    g = s.groupby(keys, dropna=False)[["_ae", "_ay"]].sum().reset_index()
    g["wape"] = np.where(g["_ay"] > 0, g["_ae"] / g["_ay"], np.nan)
    return g.drop(columns=["_ae", "_ay"])


def score_frame(
    scores: pd.DataFrame,
    segments: pd.DataFrame | None = None,
    floor_model_id: str | None = None,
) -> pd.DataFrame:
    """Aggregate ScoreSchema rows to per (block, model_id [, segment]) metrics.

    Columns out: keys + wape, bias_pct, n_scored, pct_skus_beating_floor,
    wape_origin_std (std of per-origin WAPE across origins — variance context).
    `segments` (sku, location, segment) adds a segment grouping level.
    `floor_model_id` enables pct_skus_beating_floor (share of series whose
    per-series WAPE beats the floor model's on the same series); NaN otherwise.
    """
    s = _with_terms(scores)
    if segments is not None and len(segments):
        s = s.merge(segments[["sku", "location", "segment"]], on=["sku", "location"], how="left")
        s["segment"] = s["segment"].fillna("UNSEGMENTED")
        keys = ["block", "segment", "model_id"]
    else:
        keys = ["block", "model_id"]

    out_cols = keys + ["wape", "bias_pct", "n_scored", "pct_skus_beating_floor", "wape_origin_std"]
    if s.empty:
        return pd.DataFrame(columns=out_cols)

    g = s.groupby(keys, dropna=False)
    agg = g.agg(
        _ae=("_ae", "sum"), _ay=("_ay", "sum"), _err=("_err", "sum"),
        _y=("y_true", "sum"), n_scored=("y_true", "size"),
    ).reset_index()
    agg["wape"] = np.where(agg["_ay"] > 0, agg["_ae"] / agg["_ay"], np.nan)
    agg["bias_pct"] = np.where(agg["_y"] != 0, 100.0 * agg["_err"] / agg["_y"], np.nan)
    agg = agg.drop(columns=["_ae", "_ay", "_err", "_y"])

    # Origin-level WAPE spread (std across origins, population std so a single
    # origin yields 0.0 rather than NaN).
    per_origin = _wape_by(s, keys + ["origin_date"])
    spread = (
        per_origin.groupby(keys, dropna=False)["wape"]
        .std(ddof=0)
        .rename("wape_origin_std")
        .reset_index()
    )
    agg = agg.merge(spread, on=keys, how="left")

    # % of series beating the floor model on per-series WAPE.
    agg["pct_skus_beating_floor"] = np.nan
    if floor_model_id is not None and (s["model_id"] == floor_model_id).any():
        series_keys = [k for k in keys if k != "model_id"] + ["sku", "location"]
        per_series = _wape_by(s, series_keys + ["model_id"])
        floor = (
            per_series.loc[per_series["model_id"] == floor_model_id]
            .drop(columns=["model_id"])
            .rename(columns={"wape": "_floor_wape"})
        )
        cmp = per_series.merge(floor, on=series_keys, how="inner")
        cmp = cmp.loc[np.isfinite(cmp["wape"]) & np.isfinite(cmp["_floor_wape"])]
        if len(cmp):
            beat = (
                cmp.assign(_beat=(cmp["wape"] < cmp["_floor_wape"]))
                .groupby(keys, dropna=False)["_beat"].mean().mul(100.0)
                .rename("_pct_beat").reset_index()
            )
            agg = agg.merge(beat, on=keys, how="left")
            agg["pct_skus_beating_floor"] = agg.pop("_pct_beat")

    return agg[out_cols]


def pct_vs_floor(scores: pd.DataFrame, floor_model_id: str) -> pd.DataFrame:
    """% WAPE improvement of every model vs the floor model, per block.

    pct_improvement_vs_floor > 0 means the model beats the floor. Every result
    in reporting is expressed this way — never as absolute accuracy (SPEC §10/§11).
    """
    s = _with_terms(scores)
    if s.empty:
        return pd.DataFrame(columns=["block", "model_id", "wape", "floor_wape", "pct_improvement_vs_floor"])
    per_model = _wape_by(s, ["block", "model_id"])
    floor = (
        per_model.loc[per_model["model_id"] == floor_model_id, ["block", "wape"]]
        .rename(columns={"wape": "floor_wape"})
    )
    out = per_model.merge(floor, on="block", how="left")
    out["pct_improvement_vs_floor"] = np.where(
        np.isfinite(out["floor_wape"]) & (out["floor_wape"] > 0),
        100.0 * (out["floor_wape"] - out["wape"]) / out["floor_wape"],
        np.nan,
    )
    return out
