"""Unit tests for findings + report modules (agent-report / contract G)."""
from __future__ import annotations

import zipfile

import numpy as np
import pandas as pd
import pytest

from audit_engine.config import Config
from audit_engine.findings.catalogue import catalogue_structure
from audit_engine.findings.data_quality import data_quality_findings
from audit_engine.findings.lost_sales import lost_sales, repeat_offenders
from audit_engine.findings.stock_position import stock_position
from audit_engine.report.html import default_context, render_report
from audit_engine.report.workbook import write_workbook

CFG = Config()


def _panel(rows: list[dict]) -> pd.DataFrame:
    df = pd.DataFrame(rows)
    df["week_start"] = pd.to_datetime(df["week_start"])
    if "location" not in df.columns:
        df["location"] = "ALL"
    return df


def _baseline(rows: list[dict]) -> pd.DataFrame:
    df = pd.DataFrame(rows)
    if "location" not in df.columns:
        df["location"] = "ALL"
    for col, default in [("usable_weeks", 13), ("method", "own"), ("confidence", "high")]:
        if col not in df.columns:
            df[col] = default
    return df


def _episodes(rows: list[dict]) -> pd.DataFrame:
    df = pd.DataFrame(rows)
    df["start_date"] = pd.to_datetime(df["start_date"])
    df["end_date"] = pd.to_datetime(df["end_date"])
    if "location" not in df.columns:
        df["location"] = "ALL"
    for col, default in [("p_value", 0.001), ("cross_sectional_share", 0.05)]:
        if col not in df.columns:
            df[col] = default
    return df


# ---------------------------------------------------------------------------
# lost sales
# ---------------------------------------------------------------------------

@pytest.fixture()
def lost_sales_inputs():
    weeks = pd.date_range("2024-03-04", periods=4, freq="7D")
    panel_rows = []
    for w in weeks:
        panel_rows.append({"sku": "A", "week_start": w, "units_raw": 25.0, "price_median": 10.0})
        panel_rows.append({"sku": "N", "week_start": w, "units_raw": 6.25, "price_median": 10.0})
    panel = _panel(panel_rows)
    baseline = _baseline([
        {"sku": "A", "baseline_weekly": 14.0, "baseline_daily": 2.0},
        {"sku": "N", "baseline_weekly": 3.5, "baseline_daily": 0.5},  # below velocity gate
    ])
    episodes = _episodes([
        {"sku": "A", "start_date": "2024-01-30", "end_date": "2024-02-03", "days": 5, "confidence": "high"},
        {"sku": "A", "start_date": "2024-02-10", "end_date": "2024-02-12", "days": 3, "confidence": "medium"},
        {"sku": "A", "start_date": "2024-02-20", "end_date": "2024-02-23", "days": 4, "confidence": "low"},
    ])
    return episodes, baseline, panel


def test_lost_sales_band_math(lost_sales_inputs):
    episodes, baseline, panel = lost_sales_inputs
    out = lost_sales(episodes, baseline, panel, CFG)

    # not-assessable value share: N revenue 250 of 1250 total = 0.2
    total = out["total"]
    assert total["not_assessable_value_share"] == pytest.approx(0.2)

    by_sku = out["by_sku"]
    assert len(by_sku) == 1
    row = by_sku.iloc[0]
    assert row["sku"] == "A"
    assert row["stockout_days"] == 8            # High + Medium only; Low excluded
    assert row["episodes"] == 2
    assert row["lost_units_low"] == pytest.approx(10.0)    # 2/day * 5 high days
    assert row["lost_units_high"] == pytest.approx(16.0)   # 2/day * 8 H+M days
    assert row["lost_revenue_low"] == pytest.approx(100.0)
    assert row["lost_revenue_high"] == pytest.approx(160.0)
    assert row["confidence"] == "high"

    assert total["units_low"] == pytest.approx(10.0)
    assert total["units_high"] == pytest.approx(16.0 * 1.2)   # + not-assessable allowance
    assert total["revenue_low"] == pytest.approx(100.0)
    assert total["revenue_high"] == pytest.approx(192.0)
    assert total["episodes"] == 2
    assert total["low_confidence_episodes"] == 1


def test_lost_sales_by_month_spans_month_boundary(lost_sales_inputs):
    episodes, baseline, panel = lost_sales_inputs
    bm = lost_sales(episodes, baseline, panel, CFG)["by_month"].set_index("month")

    # High episode Jan 30 - Feb 3: 2 days in Jan, 3 in Feb. Medium: 3 days in Feb.
    assert bm.loc["2024-01", "lost_units_low"] == pytest.approx(4.0)
    assert bm.loc["2024-01", "lost_units_high"] == pytest.approx(4.0 * 1.2)
    assert bm.loc["2024-02", "lost_units_low"] == pytest.approx(6.0)
    assert bm.loc["2024-02", "lost_units_high"] == pytest.approx(12.0 * 1.2)
    assert bm.loc["2024-01", "lost_revenue_high"] == pytest.approx(48.0)
    assert bm.loc["2024-02", "lost_revenue_high"] == pytest.approx(144.0)
    # months reconcile to the catalogue total
    assert bm["lost_units_high"].sum() == pytest.approx(19.2)


def test_lost_sales_empty_episodes(lost_sales_inputs):
    _, baseline, panel = lost_sales_inputs
    empty = _episodes([{"sku": "A", "start_date": "2024-01-01", "end_date": "2024-01-04",
                        "days": 4, "confidence": "low"}])
    out = lost_sales(empty, baseline, panel, CFG)
    assert out["total"]["units_high"] == 0.0
    assert out["total"]["low_confidence_episodes"] == 1
    assert out["by_sku"].empty and out["by_month"].empty


def test_repeat_offenders_threshold():
    episodes = _episodes([
        {"sku": "R", "start_date": "2024-01-01", "end_date": "2024-01-05", "days": 5, "confidence": "high"},
        {"sku": "R", "start_date": "2024-02-01", "end_date": "2024-02-05", "days": 5, "confidence": "high"},
        {"sku": "R", "start_date": "2024-03-01", "end_date": "2024-03-02", "days": 2, "confidence": "low"},
        {"sku": "Q", "start_date": "2024-01-01", "end_date": "2024-01-03", "days": 3, "confidence": "high"},
        {"sku": "Q", "start_date": "2024-02-01", "end_date": "2024-02-03", "days": 3, "confidence": "high"},
    ])
    out = repeat_offenders(episodes, CFG)      # threshold = 3 episodes
    assert list(out["sku"]) == ["R"]
    assert out.iloc[0]["episodes"] == 3        # Low episodes count, they just don't monetise
    assert out.iloc[0]["total_days"] == 12
    assert np.isnan(out.iloc[0]["est_lost_revenue"])   # no baseline/panel supplied

    baseline = _baseline([{"sku": "R", "baseline_weekly": 7.0, "baseline_daily": 1.0}])
    panel = _panel([{"sku": "R", "week_start": "2024-03-04", "units_raw": 7.0, "price_median": 5.0}])
    out2 = repeat_offenders(episodes, CFG, baseline=baseline, panel=panel)
    # est revenue = H+M days (10) x 1/day x price 5 = 50; Low episode not monetised
    assert out2.iloc[0]["est_lost_revenue"] == pytest.approx(50.0)


# ---------------------------------------------------------------------------
# stock position
# ---------------------------------------------------------------------------

@pytest.fixture()
def stock_inputs():
    max_week = pd.Timestamp("2024-06-24")
    bw10 = ["S26", "S27", "S12", "S1", "S09", "S4", "SR1", "SR2"]
    baseline = _baseline(
        [{"sku": s, "baseline_weekly": 10.0, "baseline_daily": 10.0 / 7} for s in bw10]
        + [{"sku": "DORM", "baseline_weekly": np.nan, "baseline_daily": np.nan, "method": "dormant"}]
    )
    seg_rows = []
    for s in ["S26", "S27", "S12", "S1", "S09", "S4"]:
        seg_rows.append({"sku": s, "abc": "B", "lifecycle": "active"})
    for s in ["SR1", "SR2"]:
        seg_rows.append({"sku": s, "abc": "A", "lifecycle": "active"})
    seg_rows.append({"sku": "DORM", "abc": "C", "lifecycle": "dormant"})
    for s in ["D1", "D2", "D3", "D4", "D5", "F"]:
        seg_rows.append({"sku": s, "abc": "C", "lifecycle": "active"})
    segments = pd.DataFrame(seg_rows)
    segments["location"] = "ALL"

    stock = pd.DataFrame([
        {"sku": "S26", "qty_on_hand": 260.0, "unit_cost": 1.0},
        {"sku": "S27", "qty_on_hand": 261.0, "unit_cost": 1.0},
        {"sku": "S12", "qty_on_hand": 120.0, "unit_cost": 1.0},
        {"sku": "S1", "qty_on_hand": 10.0, "unit_cost": 1.0},
        {"sku": "S09", "qty_on_hand": 9.0, "unit_cost": 1.0},
        {"sku": "S4", "qty_on_hand": 40.0, "unit_cost": 1.0},
        {"sku": "SR1", "qty_on_hand": 15.0, "unit_cost": 1.0},
        {"sku": "SR2", "qty_on_hand": 30.0, "unit_cost": 1.0},
        {"sku": "DORM", "qty_on_hand": 5.0, "unit_cost": 1.0},
        {"sku": "D1", "qty_on_hand": 4.0, "unit_cost": 2.5},
        {"sku": "D2", "qty_on_hand": 6.0, "unit_cost": 1.0},
        {"sku": "D3", "qty_on_hand": 7.0, "unit_cost": np.nan},
        {"sku": "D4", "qty_on_hand": 3.0, "unit_cost": 1.0},
        {"sku": "D5", "qty_on_hand": 2.0, "unit_cost": 1.0},
        {"sku": "F", "qty_on_hand": 8.0, "unit_cost": 1.0},
    ])
    stock["location"] = "ALL"

    panel = _panel([
        {"sku": "S4", "week_start": max_week, "units_raw": 5.0, "price_median": 10.0},
        {"sku": "D1", "week_start": max_week - pd.Timedelta(weeks=9), "units_raw": 3.0, "price_median": 10.0},
        {"sku": "D2", "week_start": max_week - pd.Timedelta(weeks=20), "units_raw": 2.0, "price_median": 10.0},
        {"sku": "D3", "week_start": max_week - pd.Timedelta(weeks=30), "units_raw": 1.0, "price_median": 10.0},
        {"sku": "D4", "week_start": max_week - pd.Timedelta(weeks=26), "units_raw": 1.0, "price_median": 10.0},
        {"sku": "D5", "week_start": max_week - pd.Timedelta(weeks=13), "units_raw": 1.0, "price_median": 10.0},
        {"sku": "F", "week_start": max_week - pd.Timedelta(weeks=2), "units_raw": 1.0, "price_median": 10.0},
    ])
    return stock, baseline, panel, segments


def test_cover_buckets_boundaries(stock_inputs):
    stock, baseline, panel, segments = stock_inputs
    out = stock_position(stock, baseline, panel, segments, CFG)
    buckets = out["cover"].set_index("sku")["bucket"].to_dict()

    assert buckets["S26"] == "Overstock"          # exactly 26 weeks -> not severe
    assert buckets["S27"] == "Severe overstock"   # 26.1 weeks
    assert buckets["S12"] == "Overstock"          # exactly 12 weeks
    assert buckets["S4"] == "Healthy"             # exactly 4 weeks
    assert buckets["S1"] == "Thin"                # exactly 1 week
    assert buckets["S09"] == "Imminent runout"    # 0.9 weeks
    assert buckets["DORM"] == "Dead"              # dormant + stock, NaN baseline
    assert buckets["D1"] == "Not assessable"      # no baseline, not dormant

    cover = out["cover"].set_index("sku")
    assert cover.loc["S26", "weeks_of_cover"] == pytest.approx(26.0)
    assert np.isnan(cover.loc["DORM", "weeks_of_cover"])   # inf-safe


def test_dead_stock_buckets_and_value(stock_inputs):
    stock, baseline, panel, segments = stock_inputs
    out = stock_position(stock, baseline, panel, segments, CFG)
    dead = out["dead_stock"].set_index("sku")

    assert set(dead.index) == {"D1", "D2", "D3", "D4", "D5"}   # F too recent
    assert dead.loc["D1", "bucket"] == "8-12w"
    assert dead.loc["D5", "bucket"] == "13-26w"    # exactly 13 weeks
    assert dead.loc["D2", "bucket"] == "13-26w"
    assert dead.loc["D4", "bucket"] == "26w+"      # exactly 26 weeks -> write-off bucket
    assert dead.loc["D3", "bucket"] == "26w+"
    assert dead.loc["D1", "value"] == pytest.approx(10.0)      # 4 x 2.5
    assert np.isnan(dead.loc["D3", "value"])                   # NaN cost -> NaN value
    assert dead.loc["D3", "qty_on_hand"] == pytest.approx(7.0) # units still counted

    cap = out["capital"]
    assert cap["dead_value_by_bucket"]["8-12w"] == pytest.approx(10.0)
    assert cap["dead_value_by_bucket"]["13-26w"] == pytest.approx(8.0)
    assert cap["dead_value_by_bucket"]["26w+"] == pytest.approx(3.0)   # D3 uncosted, skipped
    assert cap["dead_units_by_bucket"]["26w+"] == pytest.approx(10.0)  # 7 + 3 units
    assert cap["dead_stock_value"] == pytest.approx(21.0)
    assert cap["uncosted_units"] == pytest.approx(7.0)


def test_runouts_a_class_only(stock_inputs):
    stock, baseline, panel, segments = stock_inputs
    out = stock_position(stock, baseline, panel, segments, CFG)
    runouts = out["runouts"]
    # SR1: A-class, cover 1.5 < 2 -> in. SR2: A-class cover 3 -> out.
    # S09 cover 0.9 but B-class -> out. DORM: NaN cover -> out.
    assert list(runouts["sku"]) == ["SR1"]
    assert runouts.iloc[0]["weeks_of_cover"] == pytest.approx(1.5)


def test_capital_totals(stock_inputs):
    stock, baseline, panel, segments = stock_inputs
    cap = stock_position(stock, baseline, panel, segments, CFG)["capital"]
    assert cap["total_stock_value"] == pytest.approx(779.0)   # D3 has no cost, excluded
    assert cap["overstock_value"] == pytest.approx(260.0 + 261.0 + 120.0)


# ---------------------------------------------------------------------------
# catalogue structure
# ---------------------------------------------------------------------------

def test_catalogue_shares_sum_to_one():
    w = pd.Timestamp("2024-06-24")
    segments = pd.DataFrame([
        {"sku": "k1", "abc": "A", "xyz": "X", "demand_class": "smooth", "lifecycle": "active"},
        {"sku": "k2", "abc": "B", "xyz": "Y", "demand_class": "intermittent", "lifecycle": "active"},
        {"sku": "k3", "abc": "C", "xyz": "Z", "demand_class": "lumpy", "lifecycle": "active"},
        {"sku": "k4", "abc": "C", "xyz": "Z", "demand_class": "erratic", "lifecycle": "dormant"},
    ])
    segments["location"] = "ALL"
    panel = _panel([
        {"sku": "k1", "week_start": w, "units_raw": 70.0, "price_median": 10.0},
        {"sku": "k2", "week_start": w, "units_raw": 20.0, "price_median": 10.0},
        {"sku": "k3", "week_start": w, "units_raw": 6.0, "price_median": 10.0},
        {"sku": "k4", "week_start": w, "units_raw": 4.0, "price_median": 10.0},
    ])
    out = catalogue_structure(segments, panel, CFG)

    abc = out["abc"]
    assert abc["A"]["revenue_share"] == pytest.approx(0.70)
    assert abc["B"]["revenue_share"] == pytest.approx(0.20)
    assert abc["C"]["revenue_share"] == pytest.approx(0.10)
    assert sum(v["revenue_share"] for v in abc.values()) == pytest.approx(1.0)
    assert sum(v["count_share"] for v in abc.values()) == pytest.approx(1.0)

    fc = out["forecastability"]
    assert sum(v["count_share"] for v in fc.values()) == pytest.approx(1.0)
    assert sum(v["revenue_share"] for v in fc.values()) == pytest.approx(1.0)
    assert fc["smooth"]["n_skus"] == 1

    assert out["top10_revenue_share"] == pytest.approx(1.0)
    assert out["lifecycle"] == {"active": 3, "new": 0, "dormant": 1}


# ---------------------------------------------------------------------------
# data quality
# ---------------------------------------------------------------------------

def test_data_quality_findings():
    health = {
        "verdict": "go",
        "halt_reasons": [],
        "checks": [
            {"name": "history_depth", "status": "pass", "detail": "ok", "metrics": {}},
            {"name": "zero_vs_null", "status": "flag", "detail": "ambiguous weeks", "metrics": {}},
            {"name": "price_availability", "status": "fail", "detail": "62% priced", "metrics": {}},
        ],
    }
    audit_log = pd.DataFrame({
        "rule_name": ["winsorize_spike"] * 3 + ["dedupe_exact"] * 2
                     + ["bulk_order_exclude"] + ["promo_retro_tag"] * 4 + ["net_returns"],
    })
    out = data_quality_findings(health, audit_log, CFG)

    assert out["verdict"] == "go"
    assert out["n_pass"] == 1 and out["n_flag"] == 1 and out["n_fail"] == 1
    assert [c["name"] for c in out["failed"]] == ["price_availability"]

    proc = out["processing"]
    assert proc["cells_winsorized"] == 3
    assert proc["promo_weeks_detected"] == 4
    assert proc["bulk_orders_excluded"] == 1
    assert proc["rows_dropped"] == {"dedupe_exact": 2, "bulk_order_exclude": 1}
    assert proc["total_log_rows"] == 11


def test_data_quality_empty_inputs():
    out = data_quality_findings({}, None, CFG)
    assert out["verdict"] == "unknown"
    assert out["processing"]["total_log_rows"] == 0


# ---------------------------------------------------------------------------
# workbook
# ---------------------------------------------------------------------------

def test_write_workbook(tmp_path):
    sheets = {
        "Cover": pd.DataFrame({
            "sku": ["A", "B"],
            "qty_on_hand": [10.0, 5.0],
            "weeks_of_cover": [2.5, np.nan],
            "stock_value": [100.0, np.nan],
        }),
        "Dead stock": pd.DataFrame({
            "sku": ["D1"],
            "last_sale": [pd.Timestamp("2024-01-01")],
            "value": [np.nan],
        }),
        "Empty": pd.DataFrame(),
        "Bad[name]?:*": pd.DataFrame({"x": [1]}),
    }
    path = write_workbook(tmp_path / "detail.xlsx", sheets)
    assert path.exists()
    names = zipfile.ZipFile(path).namelist()
    for i in (1, 2, 3, 4):
        assert f"xl/worksheets/sheet{i}.xml" in names


# ---------------------------------------------------------------------------
# html report
# ---------------------------------------------------------------------------

SECTION_HEADINGS = [
    "Executive summary",
    "Immediate actions",
    "Lost sales analysis",
    "Stock position",
    "Catalogue structure",
    "Recommended starting model",
    "Data quality",
    "What we could not see",
    "Recommendations",
]


def test_render_report_default_context(tmp_path):
    path = render_report(default_context(), tmp_path / "report.html")
    html = path.read_text(encoding="utf-8")
    for heading in SECTION_HEADINGS:
        assert heading in html, f"missing section heading: {heading}"
    # routing is None -> pending note, no absolute-accuracy claim
    assert "pending" in html.lower()
    # limitations empty -> default line still renders under the mandatory section
    assert "No run-specific limitations were recorded" in html


def test_render_report_populated(tmp_path):
    ctx = {
        "client": "Acme Retail",
        "run_id": "r-001",
        "exec_summary": {"lost_sales_range": "£10,000 – £19,200"},
        "lost_sales": {
            "total": {"units_low": 10, "units_high": 19.2, "revenue_low": 100.0,
                      "revenue_high": 192.0, "episodes": 2,
                      "not_assessable_value_share": 0.2},
            "by_month": [{"month": "2024-01", "lost_units_low": 4, "lost_units_high": 4.8,
                          "lost_revenue_low": 40.0, "lost_revenue_high": 48.0}],
            "top_skus": [{"sku": "A", "location": "ALL", "stockout_days": 8, "episodes": 2,
                          "lost_revenue_low": 100.0, "lost_revenue_high": 192.0,
                          "confidence": "high"}],
        },
        "routing": {"table": [{"segment": "AX", "champion": "M7", "fallback": "M5",
                               "n_skus": 12, "evidence": "18% better than naive floor"}]},
        "limitations": ["Stockouts shorter than 2 days are not detectable."],
    }
    html = render_report(ctx, tmp_path / "report2.html").read_text(encoding="utf-8")
    assert "Acme Retail" in html
    assert "£10,000 – £19,200" in html               # exec summary range string
    assert "£100 – £192" in html                     # section 3 derived range
    assert "M7" in html
    assert "Stockouts shorter than 2 days are not detectable." in html
    assert "provisional" in html.lower()             # routing caveat present
