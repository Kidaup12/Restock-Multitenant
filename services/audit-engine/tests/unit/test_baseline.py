"""Unit tests for baseline/baseline.py (SPEC §6) and baseline/segments.py (§7.6/§7.7)."""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from audit_engine.baseline.baseline import compute_baseline
from audit_engine.baseline.segments import compute_segments
from audit_engine.config import Config

AS_OF = pd.Timestamp("2024-06-24")  # a Monday


@pytest.fixture()
def cfg() -> Config:
    return Config()


def make_panel(skus: dict[str, dict]) -> pd.DataFrame:
    """Build a minimal PanelSchema-shaped frame.

    Each entry: {"units": [...weekly units, oldest first, ending at 'end'...],
                 "end": Timestamp (default AS_OF), "promo": {idx}, "bulk": {idx},
                 "unusable": {idx}, "price": float}
    """
    rows = []
    for sku, d in skus.items():
        units = d["units"]
        end = d.get("end", AS_OF)
        weeks = pd.date_range(end=end, periods=len(units), freq="7D")
        promo = d.get("promo", set())
        bulk = d.get("bulk", set())
        unusable = d.get("unusable", set())
        price = d.get("price", np.nan)
        for i, (w, u) in enumerate(zip(weeks, units)):
            rows.append(
                {
                    "sku": sku,
                    "location": "ALL",
                    "week_start": w,
                    "units_raw": float(u),
                    "units_corrected": float(u),
                    "in_stock_days": 7.0,
                    "price_median": price,
                    "promo_flag": i in promo,
                    "bulk_flag": i in bulk,
                    "stockout_flag": False,
                    "stockout_confidence": "none",
                    "level_shift_flag": False,
                    "filled_zero_flag": False,
                    "usable": i not in unusable,
                }
            )
    return pd.DataFrame(rows)


def one(df: pd.DataFrame, sku: str) -> pd.Series:
    rows = df[df["sku"] == sku]
    assert len(rows) == 1
    return rows.iloc[0]


# --------------------------------------------------------------------------
# baseline math
# --------------------------------------------------------------------------

def test_median_of_full_window(cfg):
    panel = make_panel({"A": {"units": [8, 9, 10, 11, 12] + [10] * 8}})  # 13 weeks
    out = compute_baseline(panel, cfg, as_of=AS_OF)
    r = one(out, "A")
    assert r["baseline_weekly"] == pytest.approx(10.0)
    assert r["baseline_daily"] == pytest.approx(10.0 / 7)
    assert r["usable_weeks"] == 13
    assert r["method"] == "own"
    assert r["confidence"] == "high"


def test_only_trailing_window_used(cfg):
    # 17 old weeks at 100 must not leak into the trailing-13-week baseline
    panel = make_panel({"A": {"units": [100] * 17 + [10] * 13}})
    out = compute_baseline(panel, cfg, as_of=AS_OF)
    assert one(out, "A")["baseline_weekly"] == pytest.approx(10.0)


def test_promo_weeks_dropped(cfg):
    units = [10] * 13
    units[6] = 100
    panel = make_panel({"A": {"units": units, "promo": {6}}})
    out = compute_baseline(panel, cfg, as_of=AS_OF)
    r = one(out, "A")
    assert r["baseline_weekly"] == pytest.approx(10.0)  # promo week 100 excluded
    assert r["usable_weeks"] == 12
    assert r["confidence"] == "low"


def test_bulk_and_unusable_weeks_dropped(cfg):
    units = [10] * 13
    units[3] = 500
    units[9] = 400
    panel = make_panel({"A": {"units": units, "bulk": {3}, "unusable": {9}}})
    out = compute_baseline(panel, cfg, as_of=AS_OF)
    r = one(out, "A")
    assert r["baseline_weekly"] == pytest.approx(10.0)
    assert r["usable_weeks"] == 11


def test_winsorize_cap_applied(cfg):
    # median is immune to one-sided capping, so verify the cap via statistic=mean:
    # values 12x10 + 100, median 10, cap = 2*10 = 20 -> mean = (12*10 + 20)/13
    units = [10] * 12 + [100]
    panel = make_panel({"A": {"units": units}})
    cfg_mean = Config.model_validate({"baseline": {"statistic": "mean"}})
    out = compute_baseline(panel, cfg_mean, as_of=AS_OF)
    assert one(out, "A")["baseline_weekly"] == pytest.approx(140.0 / 13)
    # and the default median statistic is unaffected by the spike
    out_med = compute_baseline(panel, cfg, as_of=AS_OF)
    assert one(out_med, "A")["baseline_weekly"] == pytest.approx(10.0)


# --------------------------------------------------------------------------
# fallback ladder
# --------------------------------------------------------------------------

def test_six_to_twelve_weeks_low_confidence(cfg):
    panel = make_panel({"A": {"units": [10] * 8}})
    r = one(compute_baseline(panel, cfg, as_of=AS_OF), "A")
    assert r["method"] == "own"
    assert r["confidence"] == "low"
    assert r["baseline_weekly"] == pytest.approx(10.0)


def test_cluster_analog_with_category(cfg):
    panel = make_panel(
        {
            "TG": {"units": [10] * 5},        # 5 usable weeks < min_usable, 5 weeks since launch
            "D1": {"units": [20] * 13},
            "D2": {"units": [50] * 13},
        }
    )
    cmap = {"TG": "cat1", "D1": "cat1", "D2": "cat2"}
    r = one(compute_baseline(panel, cfg, category_map=cmap, as_of=AS_OF), "TG")
    assert r["method"] == "cluster_analog"
    assert r["confidence"] == "low"
    assert r["baseline_weekly"] == pytest.approx(20.0)  # median of cat1 'own' baselines


def test_cluster_analog_global_median_without_category(cfg):
    panel = make_panel(
        {
            "TG": {"units": [10] * 5},
            "D1": {"units": [20] * 13},
            "D2": {"units": [50] * 13},
        }
    )
    r = one(compute_baseline(panel, cfg, as_of=AS_OF), "TG")
    assert r["method"] == "cluster_analog"
    assert r["baseline_weekly"] == pytest.approx(35.0)  # median(20, 50)


def test_launch_not_assessable(cfg):
    panel = make_panel({"A": {"units": [30, 30]}, "B": {"units": [10] * 13}})
    r = one(compute_baseline(panel, cfg, as_of=AS_OF), "A")
    assert r["method"] == "launch"
    assert np.isnan(r["baseline_weekly"])
    assert np.isnan(r["baseline_daily"])
    assert r["confidence"] == "not_assessable"


def test_dormant_no_baseline(cfg):
    panel = make_panel({"A": {"units": [10] * 20, "end": AS_OF - pd.Timedelta(days=70)}})
    r = one(compute_baseline(panel, cfg, as_of=AS_OF), "A")
    assert r["method"] == "dormant"
    assert np.isnan(r["baseline_weekly"])
    assert r["confidence"] == "not_assessable"


def test_as_of_defaults_to_last_panel_week(cfg):
    panel = make_panel({"A": {"units": [10] * 13}})
    out = compute_baseline(panel, cfg)  # no as_of
    assert one(out, "A")["baseline_weekly"] == pytest.approx(10.0)


# --------------------------------------------------------------------------
# segments: ABC
# --------------------------------------------------------------------------

def test_abc_boundaries_exact_units_basis(cfg):
    # values 80 / 15 / 5 -> cumulative shares 0.80 (A), 0.95 (B), 1.00 (C)
    panel = make_panel(
        {
            "S1": {"units": [8.0] * 10},
            "S2": {"units": [1.5] * 10},
            "S3": {"units": [0.5] * 10},
        }
    )
    seg = compute_segments(panel, cfg)
    assert one(seg, "S1")["abc"] == "A"
    assert one(seg, "S2")["abc"] == "B"
    assert one(seg, "S3")["abc"] == "C"
    # constant weekly demand -> X, smooth, active -> routing cell
    assert one(seg, "S1")["segment"] == "AX"
    assert one(seg, "S2")["segment"] == "BX"
    assert one(seg, "S3")["segment"] == "CX"


def test_abc_uses_revenue_when_price_available(cfg):
    # by units S1 leads (50 vs 40 vs 10); by revenue S2 leads (400 vs 50 vs 50)
    panel = make_panel(
        {
            "S1": {"units": [5.0] * 10, "price": 1.0},
            "S2": {"units": [4.0] * 10, "price": 10.0},
            "S3": {"units": [1.0] * 10, "price": 5.0},
        }
    )
    seg = compute_segments(panel, cfg)
    assert one(seg, "S2")["abc"] == "A"   # 400/500 = 0.80
    assert one(seg, "S1")["abc"] == "B"   # 450/500 = 0.90 (tie with S3 broken by sku)
    assert one(seg, "S3")["abc"] == "C"


# --------------------------------------------------------------------------
# segments: ADI / CV^2 quadrants and XYZ
# --------------------------------------------------------------------------

def quadrant_panel() -> pd.DataFrame:
    return make_panel(
        {
            "SM": {"units": [10.0] * 30},                 # ADI 1, CV2 0      -> smooth
            "INT": {"units": [1, 0, 0, 20, 0, 0] * 5},    # ADI 3, CV2 ~0.82  -> intermittent
            "ERR": {"units": [1, 20] * 15},               # ADI 1, CV2 ~0.82  -> erratic
            "LMP": {"units": [15, 0, 0] * 10},            # ADI 3, CV2 0      -> lumpy
        }
    )


def test_demand_class_quadrants(cfg):
    seg = compute_segments(quadrant_panel(), cfg)
    assert one(seg, "SM")["demand_class"] == "smooth"
    assert one(seg, "INT")["demand_class"] == "intermittent"
    assert one(seg, "ERR")["demand_class"] == "erratic"
    assert one(seg, "LMP")["demand_class"] == "lumpy"

    sm, it = one(seg, "SM"), one(seg, "INT")
    assert sm["adi"] == pytest.approx(1.0)
    assert sm["cv2"] == pytest.approx(0.0)
    assert it["adi"] == pytest.approx(3.0)
    # non-zero sizes [1, 20] x5: mean 10.5, pop std 9.5 -> CV2 = (9.5/10.5)^2
    assert it["cv2"] == pytest.approx((9.5 / 10.5) ** 2)

    # routing flag is ADI-only (SPEC §10 bucket: "Intermittent (ADI >= 1.32)"):
    # both sparse quadrants ('intermittent' and 'lumpy') route to 'intermittent'
    assert bool(it["intermittent_flag"]) is True
    assert it["segment"] == "intermittent"
    lmp = one(seg, "LMP")
    assert bool(lmp["intermittent_flag"]) is True
    assert lmp["segment"] == "intermittent"
    # frequent-but-variable stays in ABC x XYZ routing
    assert bool(one(seg, "ERR")["intermittent_flag"]) is False
    assert one(seg, "ERR")["segment"].endswith("Y")


def test_xyz_letters(cfg):
    seg = compute_segments(quadrant_panel(), cfg)
    assert one(seg, "SM")["xyz"] == "X"     # CV 0
    assert one(seg, "ERR")["xyz"] == "Y"    # CV = 9.5/10.5 ~ 0.905
    assert one(seg, "LMP")["xyz"] == "Z"    # CV = sqrt(50)/5 ~ 1.414


# --------------------------------------------------------------------------
# segments: lifecycle routing
# --------------------------------------------------------------------------

def test_new_and_dormant_routing(cfg):
    panel = make_panel(
        {
            "ANCHOR": {"units": [10.0] * 30},  # pins as_of at AS_OF
            "NEWS": {"units": [10.0] * 5},
            "DORM": {"units": [10.0] * 20, "end": AS_OF - pd.Timedelta(days=70)},
        }
    )
    seg = compute_segments(panel, cfg)
    news, dorm = one(seg, "NEWS"), one(seg, "DORM")
    assert news["lifecycle"] == "new"
    assert news["segment"] == "new"
    assert dorm["lifecycle"] == "dormant"
    assert dorm["segment"] == "dormant"
    assert one(seg, "ANCHOR")["lifecycle"] == "active"
