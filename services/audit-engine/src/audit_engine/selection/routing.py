"""Champion selection strategies S0/S1/S2 + routing table + diagnostics (SPEC §10).

S0  one model everywhere (control: config.models.default_champion)
S1  per-segment argmin of selection-block WAPE (intermittent segment restricted
    to models that handle intermittency, via the injected `intermittent_ok` set)
S2  per-SKU argmin with guardrails (min origins, margin vs segment champion,
    winner stability); any failed guardrail falls back to the segment champion.

Champions are picked on the SELECTION block only. The routing table is always
labelled provisional — selection on censored history is never final.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .scoring import _with_terms, _wape_by

__all__ = [
    "pick_champions", "strategy_scores", "routing_table",
    "winner_stability", "selection_gap",
]


def _merge_segment(s: pd.DataFrame, segments: pd.DataFrame | None) -> pd.DataFrame:
    if segments is not None and len(segments):
        s = s.merge(segments[["sku", "location", "segment"]], on=["sku", "location"], how="left")
    else:
        s = s.copy()
        s["segment"] = None
    s["segment"] = s["segment"].fillna("ALL")
    return s


def pick_champions(
    scores_sel: pd.DataFrame,
    segments: pd.DataFrame | None,
    config,
    intermittent_ok: set[str] | None = None,
) -> pd.DataFrame:
    """Champion tables for S0/S1/S2 from selection-block scores.

    Returns tidy frame: strategy, scope ('global'|'segment'|'sku'),
    scope_value ('ALL' | segment | 'sku|location'), champion_model_id.

    `intermittent_ok`: model_ids allowed to champion the 'intermittent'
    segment (models with handles_intermittent). None = no restriction —
    the integrator supplies the real set from the roster.
    """
    default = config.models.default_champion
    ov = config.selection.per_sku_override
    rows: list[dict] = [
        {"strategy": "S0", "scope": "global", "scope_value": "ALL", "champion_model_id": default}
    ]

    s = _with_terms(scores_sel)
    if s.empty:
        return pd.DataFrame(rows)
    s = _merge_segment(s, segments)

    # ---- S1: per-segment argmin WAPE --------------------------------------
    seg_wape = _wape_by(s, ["segment", "model_id"]).sort_values(
        ["segment", "wape", "model_id"], kind="stable"
    )
    s1_champ: dict[str, str] = {}
    for seg, grp in seg_wape.groupby("segment", sort=True):
        cand = grp.dropna(subset=["wape"])
        if seg == "intermittent" and intermittent_ok is not None:
            restricted = cand[cand["model_id"].isin(intermittent_ok)]
            cand = restricted if len(restricted) else cand.iloc[0:0]
        if len(cand):
            champ = str(cand.iloc[0]["model_id"])
        elif seg == "intermittent":
            champ = config.models.intermittent_default
        else:
            champ = default
        s1_champ[seg] = champ
        rows.append({"strategy": "S1", "scope": "segment", "scope_value": seg,
                     "champion_model_id": champ})

    # ---- S2: per-SKU argmin with guardrails -------------------------------
    sku_wape = _wape_by(s, ["sku", "location", "segment", "model_id"])
    origin_counts = s.groupby(["sku", "location", "model_id"])["origin_date"].nunique()
    per_origin = _wape_by(s, ["sku", "location", "origin_date", "model_id"]).sort_values(
        ["sku", "location", "origin_date", "wape", "model_id"], kind="stable"
    )
    origin_winner = (
        per_origin.dropna(subset=["wape"])
        .groupby(["sku", "location", "origin_date"], sort=True)
        .first()
        .reset_index()
    )

    for (sku, loc), grp in sku_wape.groupby(["sku", "location"], sort=True):
        seg = grp["segment"].iloc[0]
        seg_champ = s1_champ.get(seg, default)
        cand = grp.dropna(subset=["wape"]).sort_values(["wape", "model_id"], kind="stable")
        if cand.empty:
            champion = seg_champ
        else:
            winner_id = str(cand.iloc[0]["model_id"])
            winner_wape = float(cand.iloc[0]["wape"])
            if winner_id == seg_champ:
                champion = seg_champ
            else:
                ok = True
                # guardrail 1: enough origins for this SKU
                if origin_counts.get((sku, loc, winner_id), 0) < ov.min_origins:
                    ok = False
                # guardrail 2: margin vs segment champion on this SKU
                if ok:
                    seg_row = grp.loc[grp["model_id"] == seg_champ, "wape"]
                    if seg_row.empty or not np.isfinite(seg_row.iloc[0]) or seg_row.iloc[0] <= 0:
                        ok = False
                    else:
                        margin_pct = 100.0 * (seg_row.iloc[0] - winner_wape) / seg_row.iloc[0]
                        if margin_pct < ov.min_margin_pct:
                            ok = False
                # guardrail 3: winner stable across the last K origins
                if ok:
                    ow = origin_winner.loc[
                        (origin_winner["sku"] == sku) & (origin_winner["location"] == loc)
                    ].sort_values("origin_date")
                    last_k = ow["model_id"].tail(ov.require_stability_windows)
                    if len(last_k) < ov.require_stability_windows or not (last_k == winner_id).all():
                        ok = False
                champion = winner_id if ok else seg_champ
        rows.append({"strategy": "S2", "scope": "sku", "scope_value": f"{sku}|{loc}",
                     "champion_model_id": champion})

    return pd.DataFrame(rows)


def strategy_scores(
    scores: pd.DataFrame,
    champions: pd.DataFrame,
    segments: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """Score rows each strategy would have produced: for every series keep the
    rows of that scope's champion model, tagged with a 'strategy' column.
    Used to score all three strategies on the validation block (SPEC §10)."""
    base_cols = list(scores.columns)
    out_frames: list[pd.DataFrame] = []
    s = scores.loc[scores["scored"].astype(bool)] if len(scores) else scores
    if len(s) == 0:
        empty = scores.iloc[0:0].copy()
        empty["strategy"] = pd.Series(dtype=str)
        return empty

    s = _merge_segment(s, segments)
    s["_sku_key"] = s["sku"].astype(str) + "|" + s["location"].astype(str)

    strat = {st: grp for st, grp in champions.groupby("strategy")}
    default = None
    if "S0" in strat:
        default = strat["S0"]["champion_model_id"].iloc[0]
        d0 = s.loc[s["model_id"] == default, base_cols].copy()
        d0["strategy"] = "S0"
        out_frames.append(d0)
    if "S1" in strat:
        s1_map = dict(zip(strat["S1"]["scope_value"], strat["S1"]["champion_model_id"]))
        champ = s["segment"].map(s1_map)
        if default is not None:
            champ = champ.fillna(default)
        d1 = s.loc[s["model_id"] == champ, base_cols].copy()
        d1["strategy"] = "S1"
        out_frames.append(d1)
    if "S2" in strat:
        s2_map = dict(zip(strat["S2"]["scope_value"], strat["S2"]["champion_model_id"]))
        champ = s["_sku_key"].map(s2_map)
        if "S1" in strat:
            s1_map = dict(zip(strat["S1"]["scope_value"], strat["S1"]["champion_model_id"]))
            champ = champ.fillna(s["segment"].map(s1_map))
        if default is not None:
            champ = champ.fillna(default)
        d2 = s.loc[s["model_id"] == champ, base_cols].copy()
        d2["strategy"] = "S2"
        out_frames.append(d2)

    return pd.concat(out_frames, ignore_index=True) if out_frames else s.iloc[0:0]


def winner_stability(scores_sel: pd.DataFrame) -> pd.DataFrame:
    """Per-SKU champion flip rate between consecutive selection origins.

    flip_rate = share of consecutive origin pairs whose per-origin winner
    changed. >0.40 means selection is fitting noise (SPEC §10 diagnostics).
    Returns (sku, location, n_origins, flip_rate)."""
    s = _with_terms(scores_sel)
    if s.empty:
        return pd.DataFrame(columns=["sku", "location", "n_origins", "flip_rate"])
    per_origin = _wape_by(s, ["sku", "location", "origin_date", "model_id"]).sort_values(
        ["sku", "location", "origin_date", "wape", "model_id"], kind="stable"
    )
    winners = (
        per_origin.dropna(subset=["wape"])
        .groupby(["sku", "location", "origin_date"], sort=True)
        .first()
        .reset_index()
        .sort_values(["sku", "location", "origin_date"])
    )
    rows = []
    for (sku, loc), grp in winners.groupby(["sku", "location"], sort=True):
        w = grp["model_id"].to_numpy()
        n_org = len(w)
        flip = float((w[1:] != w[:-1]).mean()) if n_org > 1 else 0.0
        rows.append({"sku": sku, "location": loc, "n_origins": n_org, "flip_rate": flip})
    return pd.DataFrame(rows)


def _strategy_wape(frame: pd.DataFrame | None) -> dict[str, float]:
    if frame is None or len(frame) == 0 or "strategy" not in frame.columns:
        return {}
    f = frame.loc[frame["scored"].astype(bool)].copy()
    if f.empty:
        return {}
    f["_ae"] = (f["y_true"] - f["y_pred"]).abs()
    f["_ay"] = f["y_true"].abs()
    g = f.groupby("strategy")[["_ae", "_ay"]].sum()
    return {
        st: (float(r["_ae"] / r["_ay"]) if r["_ay"] > 0 else float("nan"))
        for st, r in g.iterrows()
    }


def selection_gap(sel_scores: pd.DataFrame, val_scores: pd.DataFrame) -> pd.DataFrame:
    """Per-strategy winner's-curse measurement: gap = validation WAPE −
    selection WAPE. Expect S2 >> S1 > S0 ≈ 0 (SPEC §10). Both inputs are
    strategy-tagged score frames from `strategy_scores`."""
    sel_w = _strategy_wape(sel_scores)
    val_w = _strategy_wape(val_scores)
    strategies = sorted(set(sel_w) | set(val_w))
    rows = []
    for st in strategies:
        sw = sel_w.get(st, float("nan"))
        vw = val_w.get(st, float("nan"))
        rows.append({"strategy": st, "sel_wape": sw, "val_wape": vw, "gap": vw - sw})
    return pd.DataFrame(rows, columns=["strategy", "sel_wape", "val_wape", "gap"])


def routing_table(champions: pd.DataFrame, val_scores: pd.DataFrame, config) -> dict:
    """YAML-able per-segment routing table (finding 7.9).

    Champion per segment from S1; fallback = default champion (intermittent
    segment falls back to the intermittent default, or the floor model when
    the champion already is the default). Validation WAPE attached where the
    validation block scored that model; status is always provisional."""
    default = config.models.default_champion
    validated = bool(len(val_scores)) and bool(val_scores["scored"].astype(bool).any())

    val_wape_by_model: dict[str, float] = {}
    if validated:
        v = _with_terms(val_scores)
        per_model = _wape_by(v, ["model_id"])
        val_wape_by_model = {
            str(r["model_id"]): float(r["wape"])
            for _, r in per_model.iterrows() if np.isfinite(r["wape"])
        }

    segments_out: dict[str, dict] = {}
    s1 = champions.loc[champions["strategy"] == "S1"]
    for _, r in s1.iterrows():
        seg = str(r["scope_value"])
        champ = str(r["champion_model_id"])
        if seg == "intermittent":
            fallback = config.models.intermittent_default
        else:
            fallback = default
        if fallback == champ:
            fallback = default if champ != default else config.selection.floor_model
        vw = val_wape_by_model.get(champ)
        segments_out[seg] = {
            "champion": champ,
            "fallback": str(fallback),
            "val_wape": round(vw, 4) if vw is not None else None,
        }

    return {
        "status": str(config.selection.status),
        "validated": validated,
        "default_champion": str(default),
        "floor_model": str(config.selection.floor_model),
        "segments": segments_out,
    }
