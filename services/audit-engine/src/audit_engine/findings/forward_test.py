"""Finding 6c - Forward test: how the engine's CHOSEN models would have done,
rolled forward through history.

This surfaces the rolling-origin backtest the selection harness already runs
(model_scores.parquet) as a first-class, client-facing deliverable. It scores
only the models the decision policy actually picked per segment (the routing
table) - "how well would our recommendation have done" - not the full 42-model
leaderboard.

Method (documented in docs/FORWARD_TESTING.md): stand at each origin, the model
saw only earlier weeks, predicted the next `horizon` weeks, and is scored against
what actually sold. The selection block is where champions were chosen (mildly
flattering); the validation block is untouched-until-scored (the honest number).
The gap between them is the winner's curse.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def _wape_bias(df: pd.DataFrame) -> tuple[float, float, int]:
    d = df[df["scored"]]
    vol = d["y_true"].abs().sum()
    if vol == 0:
        return float("nan"), float("nan"), int(len(d))
    wape = (d["y_true"] - d["y_pred"]).abs().sum() / vol
    bias = 100 * (d["y_pred"].sum() - d["y_true"].sum()) / vol
    return float(wape), float(bias), int(len(d))


def _chosen_model_per_segment(routing: dict) -> dict[str, str]:
    """segment -> champion model id, from the routing table."""
    out = {}
    for seg, d in (routing.get("segments") or {}).items():
        champ = d.get("champion")
        if champ:
            out[str(seg)] = str(champ)
    return out


def forward_test(scores: pd.DataFrame, segments: pd.DataFrame, routing: dict) -> dict:
    """Summarise the forward test for the engine's chosen models.

    Parameters
    ----------
    scores : model_scores.parquet (block, origin_date, model_id, sku, location,
             horizon, y_true, y_pred, scored, exclusion_reason)
    segments : segments table (sku, location, segment)
    routing : run_nested()'s routing dict (segments -> {champion, ...})

    Returns dict with:
      headline      : {sel_wape, val_wape, gap, bias, n_origins_sel, n_origins_val,
                       excluded_pct}
      by_segment    : DataFrame(segment, chosen_model, sel_wape, val_wape, gap, bias, n)
      by_origin     : DataFrame(origin_date, block, wape, bias) for the chosen models
                      (the month-by-month roll-forward view)
      by_horizon    : DataFrame(horizon, wape) - error should grow with horizon
      note          : str, provisional caveat
    """
    chosen = _chosen_model_per_segment(routing)
    if "segment" not in segments.columns:
        seg = segments.copy()
        seg["segment"] = seg.get("segment", "default")
    else:
        seg = segments

    s = scores.merge(seg[["sku", "location", "segment"]], on=["sku", "location"], how="left")
    # keep only rows where the model IS the chosen model for that SKU's segment
    s["chosen_model"] = s["segment"].map(chosen)
    picked = s[(s["model_id"] == s["chosen_model"]) & s["chosen_model"].notna()].copy()

    # censoring: how much was excluded
    total = int((scores["block"] == "validation").sum() + (scores["block"] == "selection").sum())
    excluded = int((~scores["scored"]).sum())
    excluded_pct = round(100 * excluded / total, 1) if total else 0.0

    # headline per block
    sel = picked[picked["block"] == "selection"]
    val = picked[picked["block"] == "validation"]
    sel_w, sel_b, _ = _wape_bias(sel)
    val_w, val_b, _ = _wape_bias(val)
    gap = (val_w - sel_w) if (not np.isnan(sel_w) and not np.isnan(val_w)) else float("nan")
    headline = {
        "sel_wape": round(sel_w, 3) if not np.isnan(sel_w) else None,
        "val_wape": round(val_w, 3) if not np.isnan(val_w) else None,
        "gap": round(gap, 3) if not np.isnan(gap) else None,
        "bias": round(val_b, 1) if not np.isnan(val_b) else None,
        "n_origins_sel": int(sel["origin_date"].nunique()),
        "n_origins_val": int(val["origin_date"].nunique()),
        "excluded_pct": excluded_pct,
    }

    # per segment
    rows = []
    for segment, champ in sorted(chosen.items()):
        seg_rows = picked[picked["segment"] == segment]
        sw, sb, _ = _wape_bias(seg_rows[seg_rows["block"] == "selection"])
        vw, vb, n = _wape_bias(seg_rows[seg_rows["block"] == "validation"])
        rows.append({
            "segment": segment, "chosen_model": champ,
            "sel_wape": round(sw, 3) if not np.isnan(sw) else None,
            "val_wape": round(vw, 3) if not np.isnan(vw) else None,
            "gap": round(vw - sw, 3) if not (np.isnan(sw) or np.isnan(vw)) else None,
            "bias": round(vb, 1) if not np.isnan(vb) else None,
            "n": n,
        })
    by_segment = pd.DataFrame(rows)

    # per origin (the roll-forward view) - both blocks, chosen models pooled
    orows = []
    for (origin, block), g in picked.groupby(["origin_date", "block"]):
        w, b, n = _wape_bias(g)
        orows.append({"origin_date": origin, "block": block,
                      "wape": round(w, 3) if not np.isnan(w) else None,
                      "bias": round(b, 1) if not np.isnan(b) else None, "n": n})
    by_origin = pd.DataFrame(orows).sort_values("origin_date").reset_index(drop=True)

    # per horizon - error should grow with horizon (monotonicity sanity)
    hrows = []
    for h, g in picked.groupby("horizon"):
        w, _, _ = _wape_bias(g)
        hrows.append({"horizon": int(h), "wape": round(w, 3) if not np.isnan(w) else None})
    by_horizon = pd.DataFrame(hrows).sort_values("horizon").reset_index(drop=True)

    note = (
        "Forward test of the engine's chosen models: at each origin the model saw only "
        "earlier weeks and predicted forward, scored against actual sales. The selection "
        "block picked the models; the validation block was untouched until scored - the gap "
        "between them is the winner's curse. Accuracy is relative and provisional: history is "
        "censored by unrecorded stockouts, so bias matters as much as WAPE and no absolute "
        "accuracy is claimed until a stock snapshot de-censors it."
    )
    return {
        "headline": headline,
        "by_segment": by_segment,
        "by_origin": by_origin,
        "by_horizon": by_horizon,
        "note": note,
    }
