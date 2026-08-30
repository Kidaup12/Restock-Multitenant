"""Tests for the ABC x XYZ x lifecycle management playbook finding."""
from __future__ import annotations

import pandas as pd

from audit_engine.config import Config
from audit_engine.findings.playbook import playbook


def _seg(rows):
    cols = ["sku", "location", "abc", "xyz", "lifecycle", "intermittent_flag"]
    return pd.DataFrame(rows, columns=cols)


def _panel(skus):
    wk = pd.Timestamp("2025-01-06")
    return pd.DataFrame(
        [{"sku": s, "location": "ALL", "week_start": wk, "units_raw": 10.0, "price_median": 5.0}
         for s in skus]
    )


def test_lifecycle_overrides_value():
    seg = _seg([
        ["A1", "ALL", "A", "X", "dormant", False],   # dormant beats high value
        ["A2", "ALL", "A", "X", "new", False],
    ])
    out = playbook(seg, _panel(["A1", "A2"]), Config())
    per = out["per_sku"].set_index("sku")
    assert per.loc["A1", "action"] == "run_down"
    assert per.loc["A2", "action"] == "launch_watch"


def test_steady_a_forecast_erratic_a_buffer():
    seg = _seg([
        ["A1", "ALL", "A", "X", "active", False],   # steady high value -> forecast+review
        ["A2", "ALL", "A", "Z", "active", True],    # erratic high value -> buffer_rule
    ])
    out = playbook(seg, _panel(["A1", "A2"]), Config())
    per = out["per_sku"].set_index("sku")
    assert per.loc["A1", "action"] == "forecast_review"
    assert per.loc["A1", "stance"] == "forecast"
    assert per.loc["A2", "action"] == "buffer_rule"
    assert per.loc["A2", "stance"] == "rule"


def test_b_steady_autopilot():
    seg = _seg([["B1", "ALL", "B", "X", "active", False]])
    out = playbook(seg, _panel(["B1"]), Config())
    assert out["per_sku"].iloc[0]["action"] == "forecast_auto"


def test_summary_shares_and_a_breakout():
    seg = _seg([
        ["A1", "ALL", "A", "X", "active", False],
        ["A2", "ALL", "A", "Z", "active", True],
        ["C1", "ALL", "C", "Z", "dormant", True],
    ])
    out = playbook(seg, _panel(["A1", "A2", "C1"]), Config())
    by = out["by_action"]
    assert abs(by["revenue_share"].sum() - 1.0) < 1e-6
    # A breakout only contains A-items, split by XYZ/lifecycle
    cells = set(out["a_breakout"]["cell"])
    assert cells == {"X / active", "Z / active"}
