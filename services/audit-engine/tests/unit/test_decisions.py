"""Tests for the policy loader and the policy-driven decision engine."""
from __future__ import annotations

import pandas as pd
import pytest

from audit_engine.decisions import decide
from audit_engine.policy import Policy, load_policy, policy_hash

POLICY_PATH = "config/policy.yaml"


# --------------------------------------------------------------------------
# fixtures
# --------------------------------------------------------------------------
def _seg(rows):
    cols = ["sku", "location", "abc", "xyz", "adi", "cv2", "demand_class",
            "intermittent_flag", "lifecycle", "segment"]
    return pd.DataFrame(rows, columns=cols)


def _baseline(rows):
    # rows: (sku, usable_weeks)
    return pd.DataFrame(
        [{"sku": s, "location": "ALL", "baseline_weekly": 10.0, "baseline_daily": 1.4,
          "usable_weeks": w, "method": "own", "confidence": "high"} for s, w in rows]
    )


def _panel(skus, weeks=80, nonzero=True):
    wk0 = pd.Timestamp("2024-01-01")
    recs = []
    for s in skus:
        for i in range(weeks):
            units = 10.0 if nonzero else (10.0 if i % 20 == 0 else 0.0)
            recs.append({
                "sku": s, "location": "ALL",
                "week_start": wk0 + pd.Timedelta(weeks=i),
                "units_raw": units, "price_median": 5.0,
            })
    return pd.DataFrame(recs)


# --------------------------------------------------------------------------
# policy loader
# --------------------------------------------------------------------------
def test_policy_loads_nested_values():
    pol = load_policy(POLICY_PATH)
    assert pol.version == 1
    assert pol.data_sufficiency.min_weeks_forecastable == 13
    assert pol.data_sufficiency.min_weeks_backtest == 49
    assert pol.data_sufficiency.min_weeks_validated == 65
    assert pol.price.min_price_coverage_pct == 80
    assert pol.promotions.price_drop_threshold_pct == 15
    assert pol.classification.new_weeks == 8
    assert pol.actions.a_steady == "forecast_review"
    assert pol.actions.intermittent_high == "buffer_rule"
    assert pol.autopick.segment_defaults.smooth_a == "M7"
    assert pol.autopick.intermittent_default == "M9"
    assert pol.autopick.override.min_relative_wape_gain == 0.10
    assert pol.confidence.status == "provisional"


def test_policy_hash_stable():
    pol = load_policy(POLICY_PATH)
    assert policy_hash(pol) == policy_hash(load_policy(POLICY_PATH))
    # a changed threshold changes the hash
    pol2 = pol.model_copy(deep=True)
    pol2.data_sufficiency.min_weeks_forecastable = 26
    assert policy_hash(pol2) != policy_hash(pol)


def test_policy_defaults_without_file():
    pol = load_policy("does/not/exist.yaml")
    assert pol.version == 1
    assert pol.autopick.segment_defaults.smooth_a == "M7"


# --------------------------------------------------------------------------
# precedence: lifecycle
# --------------------------------------------------------------------------
def test_dormant_run_down_regardless_of_value():
    pol = load_policy(POLICY_PATH)
    seg = _seg([
        ["A1", "ALL", "A", "X", 1.0, 0.2, "smooth", False, "dormant", "dormant"],
    ])
    out = decide(seg, _baseline([("A1", 80)]), _panel(["A1"]), pol)
    row = out.per_sku.set_index("sku").loc["A1"]
    assert row["action"] == "run_down"
    assert row["model"] == "none"
    assert row["stance"] == "none"


def test_new_launch_watch():
    pol = load_policy(POLICY_PATH)
    seg = _seg([
        ["N1", "ALL", "B", "Y", 1.0, 0.3, "smooth", False, "new", "new"],
    ])
    out = decide(seg, _baseline([("N1", 80)]), _panel(["N1"]), pol)
    row = out.per_sku.set_index("sku").loc["N1"]
    assert row["action"] == "launch_watch"
    assert row["stance"] == "launch"


def test_thin_history_not_forecastable():
    pol = load_policy(POLICY_PATH)
    # 6 usable weeks (< 13), 1 non-zero week (< 4) -> thin history gate
    seg = _seg([
        ["T1", "ALL", "C", "Z", None, None, "intermittent", False, "active", "CZ"],
    ])
    panel = _panel(["T1"], weeks=6, nonzero=False)
    # force just one non-zero week
    panel["units_raw"] = [10.0, 0.0, 0.0, 0.0, 0.0, 0.0]
    out = decide(seg, _baseline([("T1", 6)]), panel, pol)
    row = out.per_sku.set_index("sku").loc["T1"]
    assert row["action"] == "pool_rule"          # cluster_analog default
    assert row["model"] == "cluster_analog"
    assert row["confidence"] == "low"
    assert any("cluster" in a for a in row["assumptions"].split("; "))


# --------------------------------------------------------------------------
# precedence: intermittency and value x steadiness
# --------------------------------------------------------------------------
def test_intermittent_a_buffer_rule_m9():
    pol = load_policy(POLICY_PATH)
    seg = _seg([
        ["I1", "ALL", "A", "Z", 2.0, 1.0, "intermittent", True, "active", "intermittent"],
    ])
    out = decide(seg, _baseline([("I1", 80)]), _panel(["I1"]), pol)
    row = out.per_sku.set_index("sku").loc["I1"]
    assert row["action"] == "buffer_rule"
    assert row["model"] == "M9"
    assert row["stance"] == "rule"


def test_steady_a_forecast_review_m7():
    pol = load_policy(POLICY_PATH)
    seg = _seg([
        ["S1", "ALL", "A", "X", 1.0, 0.2, "smooth", False, "active", "AX"],
    ])
    out = decide(seg, _baseline([("S1", 80)]), _panel(["S1"]), pol)
    row = out.per_sku.set_index("sku").loc["S1"]
    assert row["action"] == "forecast_review"
    assert row["model"] == "M7"                  # segment_defaults.smooth_a
    assert row["stance"] == "forecast"


# --------------------------------------------------------------------------
# auto-pick: backtest overrides only when it clears the margin
# --------------------------------------------------------------------------
def _routing_for_ax(champion, champ_wape, default_wape):
    return {
        "status": "provisional",
        "validated": True,
        "default_champion": "M5",
        "segments": {
            "AX": {
                "champion": champion,
                "fallback": "M5",
                "val_wape": champ_wape,
                "rule_default_val_wape": default_wape,
            }
        },
    }


def test_autopick_challenger_clears_10pct():
    pol = load_policy(POLICY_PATH)
    seg = _seg([
        ["S1", "ALL", "A", "X", 1.0, 0.2, "smooth", False, "active", "AX"],
    ])
    # M10 beats the M7 rule default by 12% (0.44 vs 0.50) -> challenger wins
    routing = _routing_for_ax("M10", champ_wape=0.44, default_wape=0.50)
    out = decide(seg, _baseline([("S1", 80)]), _panel(["S1"]), pol,
                 backtest_routing=routing)
    row = out.per_sku.set_index("sku").loc["S1"]
    assert row["model"] == "M10"
    assert "M10 overrides M7" in row["reason"]


def test_autopick_challenger_only_3pct_keeps_default():
    pol = load_policy(POLICY_PATH)
    seg = _seg([
        ["S1", "ALL", "A", "X", 1.0, 0.2, "smooth", False, "active", "AX"],
    ])
    # M10 beats M7 by only 3% (0.485 vs 0.50) -> rule default kept
    routing = _routing_for_ax("M10", champ_wape=0.485, default_wape=0.50)
    out = decide(seg, _baseline([("S1", 80)]), _panel(["S1"]), pol,
                 backtest_routing=routing)
    row = out.per_sku.set_index("sku").loc["S1"]
    assert row["model"] == "M7"
    assert "did not" in row["reason"] or "override margin" in row["reason"]


# --------------------------------------------------------------------------
# assumptions surface at catalogue and per-SKU level
# --------------------------------------------------------------------------
def test_assumptions_surface():
    pol = load_policy(POLICY_PATH)
    seg = _seg([
        ["S1", "ALL", "A", "X", 1.0, 0.2, "smooth", False, "active", "AX"],
        ["S2", "ALL", "B", "X", 1.0, 0.3, "smooth", False, "active", "BX"],
    ])
    out = decide(seg, _baseline([("S1", 80), ("S2", 80)]), _panel(["S1", "S2"]), pol,
                 price_coverage_pct=70, has_category=False, has_promo_calendar=False)
    cat = " || ".join(out.assumptions)
    assert "promo calendar" in cat
    assert "category" in cat
    assert "price coverage" in cat or "units-only" in cat
    # and on the affected SKUs
    row = out.per_sku.set_index("sku").loc["S1"]
    assert "promo calendar" in row["assumptions"]
    assert "category" in row["assumptions"]


def test_summary_revenue_share_sums_to_one():
    pol = load_policy(POLICY_PATH)
    seg = _seg([
        ["S1", "ALL", "A", "X", 1.0, 0.2, "smooth", False, "active", "AX"],
        ["I1", "ALL", "A", "Z", 2.0, 1.0, "intermittent", True, "active", "intermittent"],
        ["D1", "ALL", "C", "Z", 1.0, 1.0, "intermittent", True, "dormant", "dormant"],
    ])
    out = decide(seg, _baseline([("S1", 80), ("I1", 80), ("D1", 80)]),
                 _panel(["S1", "I1", "D1"]), pol)
    assert out.summary["revenue_share"].sum() == pytest.approx(1.0, abs=1e-6)


def test_intermittent_never_takes_combo():
    pol = load_policy(POLICY_PATH)
    seg = _seg([
        ["I1", "ALL", "A", "Z", 2.0, 1.0, "intermittent", True, "active", "intermittent"],
    ])
    routing = {
        "status": "provisional", "validated": True, "default_champion": "M5",
        "segments": {
            "intermittent": {
                "champion": "C1", "fallback": "M9",
                "val_wape": 0.30, "rule_default_val_wape": 0.50,
            }
        },
    }
    out = decide(seg, _baseline([("I1", 80)]), _panel(["I1"]), pol,
                 backtest_routing=routing)
    row = out.per_sku.set_index("sku").loc["I1"]
    assert row["model"] == "M9"                  # combo excluded, rule default kept
    assert "combo" in row["reason"]
