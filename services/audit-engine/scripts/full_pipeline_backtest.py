"""Full pro pipeline on short history, in the order requested:
  1. classify ABC x XYZ
  2. detect promos (price-based; skipped w/ assumption if no price)
  3. run the full roster + combos
  4. forward-validate MONTH BY MONTH (each origin = a month cutoff, predict next month)

Indicative only when history is short — prints per-month and pooled comparison.
Usage: uv run python scripts/full_pipeline_backtest.py <sales.csv>
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
from audit_engine.models.registry import _build  # noqa: E402
from audit_engine.models.combo_registry import build_combo_roster  # noqa: E402
from audit_engine.panel import build_matrices  # noqa: E402


def wape_bias(sub):
    vol = sub["y_true"].abs().sum()
    if vol == 0:
        return np.nan, np.nan
    return ((sub["y_true"] - sub["y_pred"]).abs().sum() / vol,
            100 * (sub["y_pred"].sum() - sub["y_true"].sum()) / vol)


def main():
    sales = Path(sys.argv[1])
    cfg = load_config(ROOT / "config" / "defaults.yaml")
    tx = load_sales(sales, cfg)
    clean = run_chain(tx, cfg, InferredAvailability())
    mats = build_matrices(clean.panel)
    seg = compute_segments(clean.panel, cfg)

    # 1. classification
    print("=== 1. ABC x XYZ ===")
    print(pd.crosstab(seg["abc"], seg["xyz"]).to_string())
    # 2. promos
    npromo = int(clean.panel["promo_flag"].sum())
    has_price = clean.panel["price_median"].notna().any()
    print(f"\n=== 2. Promo detection ===\npromo weeks flagged: {npromo}"
          + ("" if has_price else "  (no price column -> price-based detection skipped; assumption logged)"))

    # 3. roster + combos
    base_ids = ["M1", "M2", "M3", "M4_4", "M4_8", "M4_13", "M5", "M6", "M7", "M8", "M9"]
    roster = {}
    for mid in base_ids:
        try:
            roster[mid] = _build(mid, cfg)
        except Exception:
            pass
    try:
        combos = build_combo_roster(cfg)
        combos = combos[0] if isinstance(combos, tuple) else combos
        roster.update(combos)
    except Exception as e:
        print("combos unavailable:", e)
    print(f"\n=== 3. Roster: {len(roster)} models + combos ===")

    # 4. month-by-month forward validation
    weeks = mats.weeks
    n = mats.n_weeks
    Y, U = mats.Y_corrected, mats.usable_mask
    # month boundaries -> origin at each month end; predict next 4 weeks
    months = pd.Series(weeks).dt.to_period("M")
    origin_cols, origin_labels = [], []
    for m in months.unique():
        idx = np.where(months.values == m)[0]
        oi = int(idx[-1]) + 1  # cutoff after this month's last week
        if 8 <= oi <= n - 1:
            origin_cols.append(oi)
            origin_labels.append(str(m))
    horizon = 4
    print(f"\n=== 4. Forward validation, month by month ({len(origin_cols)} cutoffs, predict next {horizon}w) ===")

    rows = []
    for oi, label in zip(origin_cols, origin_labels):
        Yp, Up = Y[:, :oi], U[:, :oi]
        for mid, model in roster.items():
            fresh = model
            try:
                fresh.fit(Yp, Up, oi)
                pred = fresh.predict(list(range(1, horizon + 1)))
            except Exception:
                continue
            for hi in range(horizon):
                col = oi + hi
                if col >= n:
                    continue
                yt, yp = Y[:, col], pred[:, hi]
                ok = ~np.isnan(yt) & ~np.isnan(yp) & U[:, col]
                for si in np.where(ok)[0]:
                    rows.append((mid, label, float(yt[si]), float(yp[si])))
    df = pd.DataFrame(rows, columns=["model_id", "cutoff_month", "y_true", "y_pred"])

    # per-month winner
    print("\n--- Winner per month (lowest WAPE) ---")
    for month in origin_labels:
        sub = df[df["cutoff_month"] == month]
        if not len(sub):
            continue
        res = []
        for mid, g in sub.groupby("model_id"):
            w, b = wape_bias(g)
            if not np.isnan(w):
                res.append((mid, w, b))
        res.sort(key=lambda t: t[1])
        top = res[:3]
        print(f"  after {month}: " + ", ".join(f"{m} (WAPE {w:.2f}, bias {b:+.0f}%)" for m, w, b in top))

    # pooled
    print("\n--- Pooled across all cutoffs (top 12 by WAPE) ---")
    pooled = []
    for mid, g in df.groupby("model_id"):
        w, b = wape_bias(g)
        pooled.append((mid, w, b, len(g)))
    pooled.sort(key=lambda t: t[1])
    print(f"  {'model':<8}{'WAPE':>7}{'bias%':>8}{'n':>7}")
    for mid, w, b, nn in pooled[:12]:
        print(f"  {mid:<8}{w:>7.3f}{b:>8.1f}{nn:>7}")


if __name__ == "__main__":
    main()
