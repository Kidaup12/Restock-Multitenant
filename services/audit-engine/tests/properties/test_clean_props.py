"""Hypothesis property tests for the cleaning chain.

Kept deliberately small (<= ~30 weeks, <= 3 SKUs) so they run fast.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from hypothesis import assume, given, settings
from hypothesis import strategies as st

from audit_engine.availability.base import AvailabilitySource
from audit_engine.clean import steps
from audit_engine.clean.pipeline import run_chain
from audit_engine.config import Config

CFG = Config()
MON = pd.Timestamp("2025-01-06")  # a Monday


def wk(i: int) -> pd.Timestamp:
    return MON + pd.Timedelta(weeks=i)


def _empty_eps() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "sku": pd.Series(dtype=str),
            "location": pd.Series(dtype=str),
            "start_date": pd.Series(dtype="datetime64[ns]"),
            "end_date": pd.Series(dtype="datetime64[ns]"),
            "days": pd.Series(dtype="int64"),
            "confidence": pd.Series(dtype=str),
            "p_value": pd.Series(dtype=float),
            "cross_sectional_share": pd.Series(dtype=float),
        }
    )


class FullAvailability(AvailabilitySource):
    """Everything always in stock; no episodes. Deterministic."""

    def in_stock_days(self, daily, config):
        weekly = pd.DataFrame(columns=["sku", "location", "week_start", "in_stock_days", "confidence"])
        return weekly, _empty_eps()


@st.composite
def tx_strategy(draw, min_weeks=8, max_weeks=30, max_skus=3):
    """Transaction frames: per-sku weekly qty in 0..3 (0 = missing week) and a
    price from {10, 8} (8 is a >=15% drop, so promo weeks occur). qty <= 3
    keeps the bulk threshold (5 x median line qty >= 5) out of reach, so the
    only full-sample statistic in the chain (the bulk median) cannot flip
    flags between runs."""
    n_skus = draw(st.integers(1, max_skus))
    n_weeks = draw(st.integers(min_weeks, max_weeks))
    rows = []
    for s in range(n_skus):
        qtys = draw(st.lists(st.integers(0, 3), min_size=n_weeks, max_size=n_weeks))
        prices = draw(st.lists(st.sampled_from([10.0, 8.0]), min_size=n_weeks, max_size=n_weeks))
        for w, (q, p) in enumerate(zip(qtys, prices)):
            if q > 0:
                rows.append(
                    {
                        "date": wk(w),
                        "sku": f"S{s}",
                        "location": "ALL",
                        "qty": float(q),
                        "unit_price": p,
                        "order_id": f"o{s}-{w}",
                        "customer_type": "retail",
                        "line_type": "sale",
                    }
                )
    assume(rows)
    return pd.DataFrame(rows), n_weeks


# ---------------------------------------------------------------------------
# 1. Trailing discipline: appending future weeks never changes past values
# ---------------------------------------------------------------------------

@settings(deadline=None, max_examples=25)
@given(data=tx_strategy())
def test_appending_future_never_changes_past(data):
    tx, n_weeks = data
    cutoff = wk(max(4, n_weeks // 2))
    tx_short = tx[tx["date"] < cutoff]
    assume(len(tx_short) > 0)
    assume(len(tx_short) < len(tx))

    full = run_chain(tx, CFG, FullAvailability()).panel
    short = run_chain(tx_short, CFG, FullAvailability()).panel

    # Level-shift detection is retrospective by design (a run of capped weeks
    # is only recognisable once complete), so series where either run flags a
    # shift are excluded from the trailing-discipline comparison.
    shifted = set(full.loc[full["level_shift_flag"], "sku"]) | set(
        short.loc[short["level_shift_flag"], "sku"]
    )
    merged = short.merge(
        full, on=["sku", "location", "week_start"], suffixes=("_s", "_f"), how="inner"
    )
    merged = merged[~merged["sku"].isin(shifted)]
    assume(len(merged) > 0)

    np.testing.assert_allclose(merged["units_raw_s"], merged["units_raw_f"])
    np.testing.assert_allclose(merged["units_corrected_s"], merged["units_corrected_f"])
    assert (merged["promo_flag_s"] == merged["promo_flag_f"]).all()
    assert (merged["filled_zero_flag_s"] == merged["filled_zero_flag_f"]).all()
    assert (merged["bulk_flag_s"] == merged["bulk_flag_f"]).all()
    assert (merged["usable_s"] == merged["usable_f"]).all()


# ---------------------------------------------------------------------------
# 2. Winsorize is idempotent and never increases a value
# ---------------------------------------------------------------------------

@st.composite
def weekly_strategy(draw):
    n = draw(st.integers(5, 30))
    vals = draw(
        st.lists(
            st.floats(0.0, 100.0, allow_nan=False, allow_infinity=False),
            min_size=n,
            max_size=n,
        )
    )
    promo = draw(st.lists(st.booleans(), min_size=n, max_size=n))
    return pd.DataFrame(
        {
            "sku": ["A"] * n,
            "location": ["ALL"] * n,
            "week_start": [wk(i) for i in range(n)],
            "units_raw": vals,
            "units_corrected": vals,
            "promo_flag": promo,
            "bulk_flag": [False] * n,
        }
    )


@settings(deadline=None, max_examples=50)
@given(weekly=weekly_strategy())
def test_winsorize_idempotent_and_never_increases(weekly):
    original = weekly["units_corrected"].to_numpy(copy=True)
    once, _ = steps.step_15_winsorize(weekly, CFG)
    twice, _ = steps.step_15_winsorize(once, CFG)
    np.testing.assert_allclose(
        once["units_corrected"].to_numpy(), twice["units_corrected"].to_numpy()
    )
    assert (once["units_corrected"].to_numpy() <= original + 1e-9).all()


# ---------------------------------------------------------------------------
# 3. Availability correction never exceeds the cap multiple
# ---------------------------------------------------------------------------

@st.composite
def correction_strategy(draw):
    n = draw(st.integers(1, 30))
    raw = draw(
        st.lists(
            st.floats(0.0, 200.0, allow_nan=False, allow_infinity=False),
            min_size=n,
            max_size=n,
        )
    )
    isd = draw(st.lists(st.integers(0, 7), min_size=n, max_size=n))
    return pd.DataFrame(
        {
            "sku": ["A"] * n,
            "location": ["ALL"] * n,
            "week_start": [wk(i) for i in range(n)],
            "units_raw": raw,
            "in_stock_days": [float(d) for d in isd],
            "stockout_confidence": ["none"] * n,
        }
    )


@settings(deadline=None, max_examples=50)
@given(weekly=correction_strategy())
def test_correction_capped(weekly):
    out, _ = steps.step_13_availability_correction(weekly, CFG)
    cap = CFG.availability.correction_cap_multiple
    raw = out["units_raw"].to_numpy()
    corr = out["units_corrected"].to_numpy()
    assert np.isfinite(corr).all()
    assert (corr <= cap * raw + 1e-9).all()
    assert (corr >= raw - 1e-9).all()   # correction only ever scales up


# ---------------------------------------------------------------------------
# 4. Filled zeros only inside [first_sale, last_sale]
# ---------------------------------------------------------------------------

@settings(deadline=None, max_examples=25)
@given(data=tx_strategy())
def test_filled_zeros_only_inside_lifespan(data):
    tx, _ = data
    panel = run_chain(tx, CFG, FullAvailability()).panel
    tx = tx.copy()
    tx["week_start"] = tx["date"] - pd.to_timedelta(tx["date"].dt.weekday, unit="D")
    for sku, g in panel.groupby("sku"):
        sale_weeks = set(tx.loc[tx["sku"] == sku, "week_start"])
        first, last = min(sale_weeks), max(sale_weeks)
        filled = g.loc[g["filled_zero_flag"], "week_start"]
        assert (filled >= first).all() and (filled <= last).all()
        assert not set(filled) & sale_weeks          # sale weeks are never "filled"
        assert (g["week_start"] >= first).all() and (g["week_start"] <= last).all()
        # spine is complete: every week of the lifespan present exactly once
        expected = pd.date_range(first, last, freq="7D")
        assert list(g["week_start"].sort_values()) == list(expected)
