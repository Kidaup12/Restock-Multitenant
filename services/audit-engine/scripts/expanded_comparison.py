"""Run the expanded roster (M1-M10 + M13-M22 + CC01-CC20 combos) on a dataset,
apply the residual-correlation diversity gate to combos, and print the ranking.

Usage:
    uv run python scripts/expanded_comparison.py <sales_csv> [--client NAME]

Prints per-model WAPE + bias on selection and validation blocks, flags combos
whose members fail the <0.90 residual-correlation diversity gate, and writes
the full score table to runs/<client>/_expanded/scores.parquet.
"""
from __future__ import annotations

import sys
from itertools import combinations
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from audit_engine.availability.inferred import InferredAvailability  # noqa: E402
from audit_engine.baseline.segments import compute_segments  # noqa: E402
from audit_engine.clean.pipeline import run_chain  # noqa: E402
from audit_engine.config import load_config  # noqa: E402
from audit_engine.ingest.loaders import load_sales  # noqa: E402
from audit_engine.panel import build_matrices  # noqa: E402
from audit_engine.selection.harness import run_backtest  # noqa: E402


def make_full_roster(cfg):
    """M1-M10 base + M13-M22 extended + CC01-CC20 combos, all fresh instances."""
    from audit_engine.models.registry import _build

    base_ids = ["M1", "M2", "M3", "M4_4", "M4_8", "M4_13", "M5", "M6", "M7", "M8", "M9", "M10"]
    ext_ids = ["M13", "M14", "M15", "M16", "M17", "M18", "M19", "M20", "M21", "M22"]
    roster = {}
    for mid in base_ids + ext_ids:
        try:
            roster[mid] = _build(mid, cfg)
        except (KeyError, Exception) as e:  # noqa: BLE001
            print(f"  skip model {mid}: {e}")
    try:
        from audit_engine.models.combo_registry import build_combo_roster

        combo_roster = build_combo_roster(cfg)
        combos = combo_roster[0] if isinstance(combo_roster, tuple) else combo_roster
        roster.update(combos)
    except Exception as e:  # noqa: BLE001
        print(f"  combos unavailable: {e}")
    return roster


def wape_bias(df):
    df = df[df["scored"]].copy()
    df["ae"] = (df["y_true"] - df["y_pred"]).abs()
    g = df.groupby("model_id").agg(
        ae=("ae", "sum"),
        vol=("y_true", lambda x: x.abs().sum()),
        err=("y_pred", "sum"),
        true=("y_true", "sum"),
        n=("ae", "size"),
    )
    g["wape"] = g["ae"] / g["vol"]
    g["bias_pct"] = 100 * (g["err"] - g["true"]) / g["vol"]
    return g[["wape", "bias_pct", "n"]].sort_values("wape")


def diversity_gate(scores, roster, threshold=0.90):
    """For each combo, correlate its MEMBERS' residuals across the backtest.
    Report combos with any member pair correlation >= threshold (redundant)."""
    sel = scores[(scores["block"] == "selection") & scores["scored"]].copy()
    sel["err"] = sel["y_pred"] - sel["y_true"]
    piv = sel.pivot_table(index=["sku", "location", "origin_date", "horizon"],
                          columns="model_id", values="err")
    verdicts = []
    for cid, model in roster.items():
        members = getattr(model, "member_ids", None)
        if not members:
            continue
        present = [m for m in members if m in piv.columns]
        if len(present) < 2:
            verdicts.append((cid, members, np.nan, "members_missing"))
            continue
        cor = piv[present].corr()
        pairs = [(a, b, cor.loc[a, b]) for a, b in combinations(present, 2)]
        worst = max(pairs, key=lambda t: abs(t[2])) if pairs else (None, None, np.nan)
        status = "REDUNDANT" if abs(worst[2]) >= threshold else "diverse"
        verdicts.append((cid, "+".join(members), round(worst[2], 3), status))
    return pd.DataFrame(verdicts, columns=["combo", "members", "worst_member_corr", "gate"])


def main():
    sales = Path(sys.argv[1])
    client = "expanded"
    if "--client" in sys.argv:
        client = sys.argv[sys.argv.index("--client") + 1]

    cfg = load_config(ROOT / "config" / "defaults.yaml")
    tx = load_sales(sales, cfg)
    clean = run_chain(tx, cfg, InferredAvailability())
    mats = build_matrices(clean.panel)
    segments = compute_segments(clean.panel, cfg)

    roster = make_full_roster(cfg)
    print(f"\nRoster: {len(roster)} models/combos")
    result = run_backtest(mats, lambda: make_full_roster(cfg), cfg, segments,
                          blocks=("selection", "validation"))
    scores = result.scores
    outdir = ROOT / "runs" / client / "_expanded"
    outdir.mkdir(parents=True, exist_ok=True)
    scores.to_parquet(outdir / "scores.parquet", index=False)

    print(f"\ntier={result.tier}  excluded_pct={result.excluded_pct:.1f}")
    print("\n=== SELECTION block (all models, by WAPE) ===")
    print(wape_bias(scores[scores["block"] == "selection"]).to_string())
    val = scores[scores["block"] == "validation"]
    if len(val) and val["scored"].any():
        print("\n=== VALIDATION block (champions scored) ===")
        print(wape_bias(val).to_string())

    print("\n=== COMBO diversity gate (residual corr < 0.90) ===")
    gate = diversity_gate(scores, roster)
    if len(gate):
        print(gate.sort_values("worst_member_corr", ascending=False).to_string(index=False))
        redundant = gate[gate["gate"] == "REDUNDANT"]
        print(f"\n{len(redundant)}/{len(gate)} combos FAIL the diversity gate (members too correlated).")


if __name__ == "__main__":
    main()
