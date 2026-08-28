"""Unit tests for ingest loaders and the Phase 0 health audit."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from audit_engine.config import load_config
from audit_engine.ingest.health import render_health_text, run_health
from audit_engine.ingest.loaders import load_sales, load_stock

REPO = Path(__file__).resolve().parents[2]
FIX = REPO / "tests" / "fixtures" / "ingest"


@pytest.fixture(scope="module")
def cfg():
    return load_config(REPO / "config" / "defaults.yaml")


# --- loaders ----------------------------------------------------------------


def test_messy_file_normalises(cfg):
    tx = load_sales(FIX / "messy.csv", cfg)
    # canonical columns present
    for col in ("date", "sku", "location", "qty", "unit_price", "order_id"):
        assert col in tx.columns
    # blank rows and the missing-qty row dropped: 16 data lines - 2 blank - 1 junk
    assert len(tx) == 13
    # dd/mm/yyyy detected via the 13/01/2024 row -> whole file parsed dayfirst
    assert pd.Timestamp("2024-01-13") in set(tx["date"])
    assert pd.Timestamp("2024-01-05") in set(tx["date"])   # not 1st May
    assert pd.Timestamp("2024-05-01") not in set(tx["date"])
    # currency symbols stripped, numerics coerced
    assert tx["qty"].dtype == float
    first = tx.iloc[0]
    assert first["sku"] == "ALPHA"
    assert first["qty"] == 2.0
    assert first["unit_price"] == pytest.approx(4.50)
    # blank location defaults to ALL, others kept
    row = tx[tx["date"] == pd.Timestamp("2024-01-19")].iloc[0]
    assert row["location"] == "ALL"
    assert (tx[tx["date"] == pd.Timestamp("2024-01-13")]["location"] == "Main St").all()
    # return line retained with negative qty
    assert (tx["qty"] < 0).sum() == 1


def test_messy_stock_clamps_negative(cfg):
    stock = load_stock(FIX / "stock_messy.csv", cfg)
    assert set(["sku", "location", "qty_on_hand", "unit_cost", "_negative_stock_clamped"]) <= set(stock.columns)
    beta = stock[stock["sku"] == "BETA"].iloc[0]
    assert beta["qty_on_hand"] == 0.0
    assert bool(beta["_negative_stock_clamped"]) is True
    alpha = stock[stock["sku"] == "ALPHA"].iloc[0]
    assert alpha["qty_on_hand"] == 10.0
    assert bool(alpha["_negative_stock_clamped"]) is False
    assert np.isnan(stock[stock["sku"] == "GAMMA"].iloc[0]["unit_cost"])


def test_missing_required_column_raises(cfg, tmp_path):
    bad = tmp_path / "bad.csv"
    bad.write_text("date,sku\n2024-01-01,A\n", encoding="utf-8")
    with pytest.raises(ValueError, match="qty"):
        load_sales(bad, cfg)
    bad_stock = tmp_path / "bad_stock.csv"
    bad_stock.write_text("date,notes\n2024-01-01,x\n", encoding="utf-8")
    with pytest.raises(ValueError, match="sku"):
        load_stock(bad_stock, cfg)


def test_explicit_column_map_wins(cfg, tmp_path):
    p = tmp_path / "odd.csv"
    p.write_text("when,thing,howmany\n2024-01-01,A,3\n", encoding="utf-8")
    tx = load_sales(p, cfg, column_map={"when": "date", "thing": "sku", "howmany": "qty"})
    assert len(tx) == 1
    assert tx.iloc[0]["sku"] == "A"
    assert tx.iloc[0]["qty"] == 3.0


# --- health: go / no-go -----------------------------------------------------


def test_clean_file_passes(cfg):
    tx = load_sales(FIX / "clean.csv", cfg)
    stock = load_stock(FIX / "stock_clean.csv", cfg)
    report = run_health(tx, stock, cfg)
    assert report.verdict == "go"
    assert report.halt_reasons == []
    assert len(report.checks) == 12
    assert not any(c.status == "fail" for c in report.checks)


def test_short_history_halts(cfg):
    tx = load_sales(FIX / "short_history.csv", cfg)
    stock = load_stock(FIX / "stock_clean.csv", cfg)
    report = run_health(tx, stock, cfg)
    assert report.verdict == "no_go"
    assert any("history" in r for r in report.halt_reasons)
    depth = next(c for c in report.checks if c.name == "history_depth")
    assert depth.status == "fail"
    assert depth.metrics["median_weeks"] < cfg.data_quality.min_median_history_weeks


def test_no_price_no_cost_halts(cfg):
    tx = load_sales(FIX / "no_price_no_cost.csv", cfg)
    stock = load_stock(FIX / "stock_no_cost.csv", cfg)
    report = run_health(tx, stock, cfg)
    assert report.verdict == "no_go"
    assert any("monetised" in r for r in report.halt_reasons)
    price = next(c for c in report.checks if c.name == "price_availability")
    assert price.status == "fail"


def test_ambiguous_gaps_halt(cfg):
    tx = load_sales(FIX / "ambiguous_gaps.csv", cfg)
    report = run_health(tx, None, cfg)
    assert report.verdict == "no_go"
    assert any("zero-vs-null" in r for r in report.halt_reasons)
    chk = next(c for c in report.checks if c.name == "zero_vs_null")
    assert chk.status == "fail"
    assert chk.metrics["ambiguous_pct"] > cfg.data_quality.max_null_zero_ambiguity_pct


def test_unreconcilable_halts(cfg):
    tx = load_sales(FIX / "unreconcilable.csv", cfg)
    stock = load_stock(FIX / "stock_unreconcilable.csv", cfg)
    report = run_health(tx, stock, cfg)
    assert report.verdict == "no_go"
    assert any("unreconcilable" in r for r in report.halt_reasons)
    cov = next(c for c in report.checks if c.name == "catalogue_coverage")
    assert cov.status == "fail"
    assert cov.metrics["overlap"] == 0


# --- health: individual check mechanics ------------------------------------


def test_duplicate_detection_counts(cfg):
    tx = load_sales(FIX / "messy.csv", cfg)
    report = run_health(tx, load_stock(FIX / "stock_messy.csv", cfg), cfg)
    dup = next(c for c in report.checks if c.name == "duplicate_lines")
    # messy.csv plants one exact duplicate (26/01 BETA) and one near duplicate
    # (02/02 ALPHA, same qty, different price/order)
    assert dup.metrics["exact_duplicates"] == 1
    assert dup.metrics["near_duplicates"] == 1
    assert dup.status == "flag"


def test_negative_stock_flagged(cfg):
    tx = load_sales(FIX / "messy.csv", cfg)
    stock = load_stock(FIX / "stock_messy.csv", cfg)
    report = run_health(tx, stock, cfg)
    neg = next(c for c in report.checks if c.name == "negative_stock")
    assert neg.status == "flag"
    assert neg.metrics["n_negative"] == 1


def test_zero_vs_null_math(cfg):
    """Constructed case with hand-computable ambiguity share.

    SKU S: sales weeks 0-3 and week 9, 30 units each -> span 10w, 5 absent
    weeks, rate 150/10 = 15/wk, exp(-15) < 0.05 -> all 5 absent weeks
    ambiguous. SKU T: 1 unit in weeks 0 and 9 -> rate 0.2/wk,
    exp(-0.2) ~ 0.82 > 0.05 -> its 8 absent weeks are NOT ambiguous.
    Share = 5 / (10 + 10) = 25%.
    """
    monday = pd.Timestamp("2024-01-01")
    rows = []
    for i in (0, 1, 2, 3, 9):
        rows.append({"date": monday + pd.Timedelta(weeks=i), "sku": "S", "qty": 30.0})
    for i in (0, 9):
        rows.append({"date": monday + pd.Timedelta(weeks=i), "sku": "T", "qty": 1.0})
    tx = pd.DataFrame(rows)
    tx["location"] = "ALL"
    tx["unit_price"] = 5.0
    report = run_health(tx, None, cfg)
    chk = next(c for c in report.checks if c.name == "zero_vs_null")
    assert chk.metrics["absent_weeks"] == 13   # 5 for S + 8 for T
    assert chk.metrics["ambiguous_weeks"] == 5
    assert chk.metrics["total_span_weeks"] == 20
    assert chk.metrics["ambiguous_pct"] == pytest.approx(25.0)
    assert chk.status == "flag"                # ambiguity present but under the halt threshold


def test_return_lag_measured(cfg):
    tx = load_sales(FIX / "clean.csv", cfg)
    report = run_health(tx, load_stock(FIX / "stock_clean.csv", cfg), cfg)
    lag = next(c for c in report.checks if c.name == "return_lag")
    assert lag.metrics["n_returns"] == 2
    assert lag.metrics["median_lag_days"] is not None
    assert 0 <= lag.metrics["median_lag_days"] <= 7


def test_render_health_text(cfg):
    tx = load_sales(FIX / "short_history.csv", cfg)
    report = run_health(tx, load_stock(FIX / "stock_clean.csv", cfg), cfg)
    text = render_health_text(report)
    assert "NO-GO" in text
    assert "history_depth" in text
    assert "| Check | Status | Detail |" in text
    go_text = render_health_text(run_health(load_sales(FIX / "clean.csv", cfg),
                                            load_stock(FIX / "stock_clean.csv", cfg), cfg))
    assert "**Verdict: GO**" in go_text
