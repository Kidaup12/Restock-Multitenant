"""Unit tests for the synthetic generator (SPEC §15 planted faults)."""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest
from pandas.testing import assert_frame_equal

from audit_engine.schemas import StockSchema, TxSchema
from audit_engine.synth.generator import SCENARIOS, generate

SMALL = dict(n_weeks=60, n_smooth=30, n_intermittent=8, n_seasonal=4)


@pytest.fixture(scope="module")
def full_result():
    return generate("full", seed=123, **SMALL)


def _weekly_units(sales: pd.DataFrame, week_starts: pd.DatetimeIndex, sku: str) -> pd.Series:
    """Weekly sold units for one sku on the full weekly spine (zeros filled)."""
    sub = sales[(sales["sku"] == sku) & (sales["line_type"] == "sale")]
    start = week_starts[0]
    wk = start + pd.to_timedelta(((sub["date"] - start).dt.days // 7) * 7, unit="D")
    totals = sub.groupby(wk)["qty"].sum()
    return totals.reindex(week_starts, fill_value=0.0)


def _week_spine(result) -> pd.DatetimeIndex:
    return pd.DatetimeIndex(sorted(result.truth["true_rate"]["week_start"].unique()))


# --------------------------------------------------------------------------
# determinism + schemas
# --------------------------------------------------------------------------


def test_unknown_scenario_raises():
    with pytest.raises(ValueError, match="unknown scenario"):
        generate("nope", seed=1, n_weeks=40, n_smooth=4, n_intermittent=2, n_seasonal=2)


def test_determinism_same_seed_identical_frames():
    a = generate("full", seed=7, n_weeks=50, n_smooth=26, n_intermittent=6, n_seasonal=3)
    b = generate("full", seed=7, n_weeks=50, n_smooth=26, n_intermittent=6, n_seasonal=3)
    assert_frame_equal(a.sales, b.sales)
    assert_frame_equal(a.stock, b.stock)
    assert set(a.truth) == set(b.truth)
    for key in a.truth:
        assert_frame_equal(a.truth[key], b.truth[key])


def test_schemas_validate(full_result):
    TxSchema.validate(full_result.sales)
    StockSchema.validate(full_result.stock)
    assert (full_result.sales["location"] == "ALL").all()
    assert full_result.sales["date"].dtype == "datetime64[ns]"


def test_truth_keys_always_present(full_result):
    expected = {
        "stockouts",
        "closures",
        "promos",
        "spikes",
        "bulk_orders",
        "renames",
        "level_shifts",
        "returns",
        "true_rate",
    }
    assert expected <= set(full_result.truth)


# --------------------------------------------------------------------------
# planted faults
# --------------------------------------------------------------------------


def test_stockouts_zeroed_and_truth_matches(full_result):
    truth = full_result.truth["stockouts"]
    assert len(truth) == 8
    assert set(truth["days"]) == {2, 5, 10, 20}
    assert (truth["lambda_daily"] >= 3.0).all()  # known-lambda, detectable band
    sales = full_result.sales
    for row in truth.itertuples(index=False):
        assert row.days == (row.end_date - row.start_date).days + 1
        in_window = sales[
            (sales["sku"] == row.sku)
            & (sales["date"] >= row.start_date)
            & (sales["date"] <= row.end_date)
        ]
        assert in_window["qty"].sum() == 0.0
        assert len(in_window) == 0
        # demand existed during the run: uncensored true rate is positive
        tr = full_result.truth["true_rate"]
        wk = tr[
            (tr["sku"] == row.sku)
            & (tr["week_start"] <= row.end_date)
            & (tr["week_start"] >= row.start_date - pd.Timedelta(days=6))
        ]
        assert (wk["lambda_weekly"] > 0).all()


def test_closures_zero_catalogue_wide(full_result):
    closures = full_result.truth["closures"]
    assert len(closures) >= 1
    for day in closures["date"]:
        assert len(full_result.sales[full_result.sales["date"] == day]) == 0


def test_promos_show_uplift_and_price_drop(full_result):
    promos = full_result.truth["promos"]
    assert len(promos) == 4
    assert (promos["uplift"] >= 1.5).all()
    assert (promos["price_drop_pct"] >= 15.0).all()
    week_starts = _week_spine(full_result)
    sales = full_result.sales
    for row in promos.itertuples(index=False):
        weekly = _weekly_units(sales, week_starts, row.sku)
        others = weekly.drop(row.week_start)
        assert weekly.loc[row.week_start] > 1.25 * others.median()
        # visible price drop >= 15% below the SKU's modal price
        sku_lines = sales[(sales["sku"] == row.sku) & (sales["line_type"] == "sale")]
        modal_price = sku_lines["unit_price"].mode().iloc[0]
        in_week = sku_lines[
            (sku_lines["date"] >= row.week_start)
            & (sku_lines["date"] < row.week_start + pd.Timedelta(days=7))
        ]
        assert len(in_week) > 0
        assert (in_week["unit_price"] == row.promo_price).all()
        assert (modal_price - row.promo_price) / modal_price >= 0.15
        # uncensored true rate carries the uplift (demand was real)
        tr = full_result.truth["true_rate"]
        sku_tr = tr[tr["sku"] == row.sku].set_index("week_start")["lambda_weekly"]
        baseline_lam = sku_tr.drop(row.week_start).median()
        assert np.isclose(sku_tr.loc[row.week_start] / baseline_lam, row.uplift, rtol=1e-6)


def test_spikes_in_true_rate_normal_price(full_result):
    spikes = full_result.truth["spikes"]
    assert len(spikes) == 3
    tr = full_result.truth["true_rate"]
    sales = full_result.sales
    for row in spikes.itertuples(index=False):
        sku_tr = tr[tr["sku"] == row.sku].set_index("week_start")["lambda_weekly"]
        assert np.isclose(sku_tr.loc[row.week_start] / sku_tr.drop(row.week_start).median(),
                          row.factor, rtol=1e-6)
        assert 5.0 <= row.factor <= 10.0
        # price stays normal during the spike (no promo signature)
        in_week = sales[
            (sales["sku"] == row.sku)
            & (sales["date"] >= row.week_start)
            & (sales["date"] < row.week_start + pd.Timedelta(days=7))
        ]
        modal_price = sales[sales["sku"] == row.sku]["unit_price"].mode().iloc[0]
        assert (in_week["unit_price"] >= 0.94 * modal_price).all()


def test_level_shifts_in_true_rate(full_result):
    shifts = full_result.truth["level_shifts"]
    assert len(shifts) == 3
    tr = full_result.truth["true_rate"]
    for row in shifts.itertuples(index=False):
        sku_tr = tr[tr["sku"] == row.sku].set_index("week_start")["lambda_weekly"]
        before = sku_tr[sku_tr.index < row.week_start].mean()
        after = sku_tr[sku_tr.index >= row.week_start].mean()
        assert 2.0 <= row.factor <= 3.0
        assert np.isclose(after / before, row.factor, rtol=1e-6)


def test_bulk_orders_wholesale_over_threshold(full_result):
    bulk = full_result.truth["bulk_orders"]
    assert len(bulk) == 4
    sales = full_result.sales
    for row in bulk.itertuples(index=False):
        line = sales[sales["order_id"] == row.order_id]
        assert len(line) == 1
        assert line["customer_type"].iat[0] == "wholesale"
        assert line["qty"].iat[0] == row.qty
        retail_median = sales[
            (sales["sku"] == row.sku)
            & (sales["customer_type"] == "retail")
            & (sales["qty"] > 0)
        ]["qty"].median()
        assert row.qty > 5 * retail_median


def test_returns_negative_lines_1_to_3_weeks_late(full_result):
    returns = full_result.truth["returns"]
    assert len(returns) >= 3
    sales = full_result.sales
    lags = (returns["return_date"] - returns["sale_date"]).dt.days
    assert (lags >= 7).all() and (lags <= 25).all()  # 1-3 weeks (+closure bumps)
    for row in returns.head(20).itertuples(index=False):
        line = sales[
            (sales["order_id"] == row.order_id)
            & (sales["line_type"] == "return")
            & (sales["date"] == row.return_date)
        ]
        assert len(line) == 1
        assert line["qty"].iat[0] == -row.qty
        # a matching positive sale exists on the sale date, same order_id
        sale = sales[
            (sales["order_id"] == row.order_id)
            & (sales["line_type"] == "sale")
            & (sales["date"] == row.sale_date)
        ]
        assert len(sale) == 1 and sale["qty"].iat[0] == row.qty


def test_renames_old_stops_new_continues(full_result):
    renames = full_result.truth["renames"]
    assert len(renames) == 2
    sales = full_result.sales
    tr = full_result.truth["true_rate"]
    for row in renames.itertuples(index=False):
        old_lines = sales[sales["sku"] == row.old_sku]
        new_lines = sales[sales["sku"] == row.new_sku]
        assert len(old_lines) > 0 and len(new_lines) > 0
        assert old_lines["date"].max() < row.switch_date
        assert new_lines["date"].min() >= row.switch_date
        # true_rate relabelled the same way — same process continues
        assert (tr[tr["sku"] == row.old_sku]["week_start"] < row.switch_date).all()
        assert (tr[tr["sku"] == row.new_sku]["week_start"] >= row.switch_date).all()
        assert len(tr[tr["sku"] == row.new_sku]) > 0
    # stock export uses today's (new) labels
    stock_skus = set(full_result.stock["sku"])
    assert set(renames["new_sku"]) <= stock_skus
    assert not (set(renames["old_sku"]) & stock_skus)


# --------------------------------------------------------------------------
# scenario targeting
# --------------------------------------------------------------------------


def test_clean_scenario_has_no_faults():
    res = generate("clean", seed=5, n_weeks=40, n_smooth=6, n_intermittent=4, n_seasonal=2)
    for key, df in res.truth.items():
        if key == "true_rate":
            assert len(df) > 0
        else:
            assert len(df) == 0, key
    assert (res.sales["qty"] > 0).all()
    assert (res.sales["customer_type"] == "retail").all()
    assert (res.sales["line_type"] == "sale").all()


def test_stockouts_only_scenario_targets():
    res = generate("stockouts_only", seed=9, n_weeks=60, n_smooth=20, n_intermittent=2, n_seasonal=2)
    assert len(res.truth["stockouts"]) > 0
    for key in ("closures", "promos", "spikes", "bulk_orders", "renames", "level_shifts", "returns"):
        assert len(res.truth[key]) == 0


def test_intermittent_scenario_realized_adi():
    res = generate("intermittent", seed=11, n_weeks=80, n_intermittent=20)
    week_starts = _week_spine(res)
    skus = sorted(res.truth["true_rate"]["sku"].unique())
    assert len(skus) == 20
    for sku in skus:
        weekly = _weekly_units(res.sales, week_starts, sku).to_numpy()
        nz = np.flatnonzero(weekly > 0)
        assert len(nz) >= 2
        adi = float(np.diff(nz).mean())
        assert adi >= 1.32


# --------------------------------------------------------------------------
# pure model-process scenarios (harness acceptance)
# --------------------------------------------------------------------------


def test_proc_scenarios_all_generate():
    for scen in ("proc_stable", "proc_noise"):
        res = generate(scen, seed=3, n_weeks=40, n_smooth=6)
        assert len(res.sales) > 0
        assert len(res.truth["true_rate"]) == 6 * 40
        for key, df in res.truth.items():
            if key != "true_rate":
                assert len(df) == 0


def test_proc_seasonal_has_strong_annual_cycle():
    res = generate("proc_seasonal", seed=13, n_weeks=104, n_seasonal=5)
    tr = res.truth["true_rate"]
    for sku, grp in tr.groupby("sku"):
        lam = grp.sort_values("week_start")["lambda_weekly"].to_numpy()
        assert lam.max() / max(lam.min(), 1e-9) >= 2.0  # amplitude >= 0.6 -> ratio >= 4 in theory


def test_proc_trend_lambda_increases():
    res = generate("proc_trend", seed=17, n_weeks=60, n_smooth=6)
    tr = res.truth["true_rate"]
    for sku, grp in tr.groupby("sku"):
        lam = grp.sort_values("week_start")["lambda_weekly"].to_numpy()
        assert lam[-8:].mean() > 1.5 * lam[:8].mean()
        assert (np.diff(lam) >= -1e-9).all()  # monotone non-decreasing


def test_proc_intermittent_adi_near_3():
    res = generate("proc_intermittent", seed=19, n_weeks=80, n_intermittent=15)
    week_starts = _week_spine(res)
    adis = []
    for sku in sorted(res.truth["true_rate"]["sku"].unique()):
        weekly = _weekly_units(res.sales, week_starts, sku).to_numpy()
        nz = np.flatnonzero(weekly > 0)
        if len(nz) >= 2:
            adis.append(float(np.diff(nz).mean()))
    assert 2.3 <= float(np.mean(adis)) <= 3.7


def test_proc_dying_final_four_weeks_zero():
    res = generate("proc_dying", seed=23, n_weeks=60, n_smooth=8)
    week_starts = _week_spine(res)
    cutoff = week_starts[-4]
    assert len(res.sales[res.sales["date"] >= cutoff]) == 0
    tr = res.truth["true_rate"]
    assert (tr[tr["week_start"] >= cutoff]["lambda_weekly"] == 0.0).all()
    # but the item was alive earlier
    assert res.sales["qty"].sum() > 0


# --------------------------------------------------------------------------
# csv round-trip
# --------------------------------------------------------------------------


def test_write_csvs_roundtrip(full_result, tmp_path):
    paths = full_result.write_csvs(tmp_path)
    assert set(paths) >= {"sales", "stock", "truth_stockouts", "truth_true_rate"}
    sales_rt = pd.read_csv(paths["sales"], parse_dates=["date"])
    assert_frame_equal(full_result.sales, sales_rt, check_dtype=False)
    stock_rt = pd.read_csv(paths["stock"])
    assert_frame_equal(full_result.stock, stock_rt, check_dtype=False)
    so_rt = pd.read_csv(paths["truth_stockouts"], parse_dates=["start_date", "end_date"])
    assert_frame_equal(full_result.truth["stockouts"], so_rt, check_dtype=False)
    tr_rt = pd.read_csv(paths["truth_true_rate"], parse_dates=["week_start"])
    assert_frame_equal(full_result.truth["true_rate"], tr_rt, check_dtype=False)
    # re-read sales still passes the schema once dates are parsed
    TxSchema.validate(sales_rt)


def test_scenarios_constant_is_complete():
    assert set(SCENARIOS) == {
        "full", "clean", "stockouts_only", "closures", "promos", "intermittent",
        "proc_stable", "proc_trend", "proc_seasonal", "proc_intermittent",
        "proc_dying", "proc_noise",
    }
