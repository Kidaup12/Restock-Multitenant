"""Tests for the forward-test finding (surfaces the harness backtest)."""
from __future__ import annotations

import pandas as pd

from audit_engine.findings.forward_test import forward_test


def _scores():
    rows = []
    # two segments, chosen models M9 (intermittent) and M5 (dormant)
    for block, origins in [("selection", ["2025-01-06", "2025-02-03"]),
                           ("validation", ["2025-03-03"])]:
        for origin in origins:
            for h in (1, 2):
                # M9 on intermittent SKU s1 - decent
                rows.append(dict(block=block, origin_date=pd.Timestamp(origin), model_id="M9",
                                 sku="s1", location="ALL", horizon=h, y_true=4.0, y_pred=3.0,
                                 scored=True, exclusion_reason=None))
                # M5 also predicts s1 but is NOT the chosen model there -> must be ignored
                rows.append(dict(block=block, origin_date=pd.Timestamp(origin), model_id="M5",
                                 sku="s1", location="ALL", horizon=h, y_true=4.0, y_pred=0.0,
                                 scored=True, exclusion_reason=None))
                # M5 on dormant SKU s2 - chosen there
                rows.append(dict(block=block, origin_date=pd.Timestamp(origin), model_id="M5",
                                 sku="s2", location="ALL", horizon=h, y_true=2.0, y_pred=2.0,
                                 scored=True, exclusion_reason=None))
    return pd.DataFrame(rows)


def _segments():
    return pd.DataFrame([
        {"sku": "s1", "location": "ALL", "segment": "intermittent"},
        {"sku": "s2", "location": "ALL", "segment": "dormant"},
    ])


def _routing():
    return {"segments": {"intermittent": {"champion": "M9"}, "dormant": {"champion": "M5"}}}


def test_scores_only_the_chosen_model_per_segment():
    ft = forward_test(_scores(), _segments(), _routing())
    # s1's M5 predictions (0 vs 4) must be ignored; only M9 (3 vs 4) counts for s1
    seg = ft["by_segment"].set_index("segment")
    assert seg.loc["intermittent", "chosen_model"] == "M9"
    assert seg.loc["dormant", "chosen_model"] == "M5"
    # dormant chosen model M5 is perfect (2 vs 2) -> wape 0
    assert seg.loc["dormant", "val_wape"] == 0.0


def test_headline_has_both_blocks_and_gap():
    ft = forward_test(_scores(), _segments(), _routing())
    h = ft["headline"]
    assert h["n_origins_sel"] == 2 and h["n_origins_val"] == 1
    assert h["sel_wape"] is not None and h["val_wape"] is not None
    assert h["gap"] == round(h["val_wape"] - h["sel_wape"], 3)


def test_roll_forward_and_horizon_views():
    ft = forward_test(_scores(), _segments(), _routing())
    assert set(ft["by_origin"]["block"]) == {"selection", "validation"}
    assert list(ft["by_horizon"]["horizon"]) == [1, 2]


def test_excluded_pct_reported():
    sc = _scores()
    sc.loc[sc.index[:4], "scored"] = False  # mark some censored
    ft = forward_test(sc, _segments(), _routing())
    assert ft["headline"]["excluded_pct"] > 0
