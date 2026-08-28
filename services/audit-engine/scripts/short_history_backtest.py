"""Force a model comparison on short history (< 49 weeks).

Bypasses the engine's history gate deliberately, with reduced train window and
step, so it physically fits. Results are INDICATIVE ONLY — too few origins to
trust. Prints per-model WAPE/bias on whatever origins fit.

Usage: uv run python scripts/short_history_backtest.py <sales.csv> [min_train] [step] [horizon]
"""
from __future__ import annotations

import sys
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
from audit_engine.models.registry import build_roster  # noqa: E402
from audit_engine.panel import build_matrices  # noqa: E402
from audit_engine.models.base import insufficient_history  # noqa: E402


def main():
    sales = Path(sys.argv[1])
    min_train = int(sys.argv[2]) if len(sys.argv) > 2 else 8
    step = int(sys.argv[3]) if len(sys.argv) > 3 else 2
    horizon = int(sys.argv[4]) if len(sys.argv) > 4 else 2

    cfg = load_config(ROOT / "config" / "defaults.yaml")
    tx = load_sales(sales, cfg)
    clean = run_chain(tx, cfg, InferredAvailability())
    mats = build_matrices(clean.panel)
    seg = compute_segments(clean.panel, cfg)
    n = mats.n_weeks
    print(f"usable weeks: {n}; min_train={min_train}, step={step}, horizon={horizon}")

    # origins where a full horizon still fits
    origins = list(range(min_train, n - horizon + 1, step))
    if not origins:
        print("no origins fit even with reduced settings")
        return
    print(f"origins (cutoff week index): {origins}  ({len(origins)} forward tests)")

    roster = build_roster(cfg)
    seg_map = seg.set_index(["sku", "location"])["segment"].to_dict()
    Y = mats.Y_corrected
    U = mats.usable_mask
    rows = []
    for oi in origins:
        Yp, Up = Y[:, :oi], U[:, :oi]
        for mid, model in roster.items():
            try:
                model.fit(Yp, Up, oi)
                pred = model.predict(list(range(1, horizon + 1)))
            except Exception:
                continue
            for hi, h in enumerate(range(1, horizon + 1)):
                tgt_col = oi + h - 1
                if tgt_col >= n:
                    continue
                yt = Y[:, tgt_col]
                yp = pred[:, hi]
                ok = ~np.isnan(yt) & ~np.isnan(yp) & U[:, tgt_col]
                for si in np.where(ok)[0]:
                    rows.append((mid, oi, h, float(yt[si]), float(yp[si])))
    df = pd.DataFrame(rows, columns=["model_id", "origin", "horizon", "y_true", "y_pred"])
    df["ae"] = (df["y_true"] - df["y_pred"]).abs()
    g = df.groupby("model_id").agg(ae=("ae", "sum"), vol=("y_true", lambda x: x.abs().sum()),
                                   pred=("y_pred", "sum"), true=("y_true", "sum"), n=("ae", "size"))
    g["WAPE"] = (g["ae"] / g["vol"]).round(3)
    g["bias%"] = (100 * (g["pred"] - g["true"]) / g["vol"]).round(1)
    print("\n=== INDICATIVE model comparison (short history — NOT validated) ===")
    print(g[["WAPE", "bias%", "n"]].sort_values("WAPE").to_string())


if __name__ == "__main__":
    main()
