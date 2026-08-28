"""Planted-fault injectors for the synthetic generator (SPEC §15).

One function per planted fault. Three layers, applied in this order by the
generator:

1. Demand-level faults mutate the lambda matrix BEFORE the Poisson draw
   (promos with uplift + visible price drop, influencer spikes, level
   shifts) — these are *real* demand, so they appear in truth['true_rate'].
2. Censoring faults zero the drawn units AFTER the draw (stockouts,
   whole-catalogue closures) — demand existed, sales did not, so they do
   NOT reduce truth['true_rate'].
3. Transaction-level faults act on the built line-level frame (bulk
   wholesale orders, late-netted returns, SKU renames).

Every function returns the matching truth table (see synth.truth).
All randomness comes from the caller's numpy Generator — deterministic per
seed.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from audit_engine.config import Config
from audit_engine.synth.truth import LOCATION, make_table

# --------------------------------------------------------------------------
# censoring faults (post-draw, units matrix)
# --------------------------------------------------------------------------


def plant_stockouts(
    units: np.ndarray,
    lam: np.ndarray,
    cat: pd.DataFrame,
    dates: pd.DatetimeIndex,
    sku_positions: list[int],
    rng: np.random.Generator,
    durations: tuple[int, ...] = (2, 5, 10, 20),
    per_duration: int = 2,
    blocked_days: frozenset[int] | set[int] = frozenset(),
) -> pd.DataFrame:
    """Zero sales for known runs of 2/5/10/20 days on known-lambda SKUs.

    Mutates ``units`` in place. Runs avoid ``blocked_days`` (closure days) so
    each truth row is a pure SKU-level stockout. One run per SKU; durations
    are cycled so every length is covered before repeats.
    """
    n_days = units.shape[1]
    dur_seq = [d for _ in range(per_duration) for d in durations]
    rows: list[dict] = []
    for i, run_len in zip(sku_positions, dur_seq):
        lo = max(91, n_days // 4)
        hi = n_days - run_len - 7
        if hi <= lo:
            continue
        start = None
        for _ in range(500):
            cand = int(rng.integers(lo, hi))
            if all((cand + k) not in blocked_days for k in range(run_len)):
                start = cand
                break
        if start is None:
            continue
        units[i, start : start + run_len] = 0
        rows.append(
            {
                "sku": cat["sku"].iat[i],
                "location": LOCATION,
                "start_date": dates[start],
                "end_date": dates[start + run_len - 1],
                "days": run_len,
                "lambda_daily": float(lam[i, start : start + run_len].mean()),
            }
        )
    return make_table("stockouts", rows)


def plant_closures(
    units: np.ndarray,
    dates: pd.DatetimeIndex,
    rng: np.random.Generator,
    n_closures: int = 3,
) -> tuple[pd.DataFrame, set[int]]:
    """Whole-catalogue closure days: zero every SKU's sales on known dates.

    Mutates ``units`` in place. Returns (truth_df, set of day indices) so the
    caller can keep other planted events off those days.
    """
    n_days = len(dates)
    lo = min(60, max(14, n_days // 4))
    hi = n_days - 7
    if hi <= lo:
        return make_table("closures"), set()
    pool = np.arange(lo, hi)
    take = min(n_closures, len(pool))
    days = np.sort(rng.choice(pool, size=take, replace=False))
    units[:, days] = 0
    rows = [{"date": dates[int(d)]} for d in days]
    return make_table("closures", rows), {int(d) for d in days}


# --------------------------------------------------------------------------
# demand-level faults (pre-draw, lambda matrix)
# --------------------------------------------------------------------------


def plant_promos(
    lam: np.ndarray,
    price_mat: np.ndarray,
    cat: pd.DataFrame,
    week_starts: pd.DatetimeIndex,
    sku_positions: list[int],
    rng: np.random.Generator,
    config: Config,
) -> pd.DataFrame:
    """Promo weeks: known demand uplift AND a visible price drop.

    The drop is planted at (threshold+5)..(threshold+15) percent below the
    SKU's modal price so retro price-detection (config
    events.price_drop_threshold_pct) can find it. Mutates ``lam`` and
    ``price_mat`` (per sku x week unit price) in place.
    """
    thr = float(config.events.price_drop_threshold_pct)
    n_weeks = len(week_starts)
    rows: list[dict] = []
    for i in sku_positions:
        if n_weeks < 17:
            break
        week = int(rng.integers(13, n_weeks - 3))
        uplift = float(rng.uniform(1.8, 2.5))
        drop_pct = float(rng.uniform(thr + 5, thr + 15))
        lam[i, week * 7 : (week + 1) * 7] *= uplift
        promo_price = round(float(cat["price"].iat[i]) * (1 - drop_pct / 100), 2)
        price_mat[i, week] = promo_price
        rows.append(
            {
                "sku": cat["sku"].iat[i],
                "location": LOCATION,
                "week_start": week_starts[week],
                "uplift": uplift,
                "price_drop_pct": drop_pct,
                "promo_price": promo_price,
            }
        )
    return make_table("promos", rows)


def plant_spikes(
    lam: np.ndarray,
    cat: pd.DataFrame,
    week_starts: pd.DatetimeIndex,
    sku_positions: list[int],
    rng: np.random.Generator,
) -> pd.DataFrame:
    """Single influencer spikes: one week at 5-10x demand, price unchanged."""
    n_weeks = len(week_starts)
    rows: list[dict] = []
    for i in sku_positions:
        if n_weeks < 17:
            break
        week = int(rng.integers(13, n_weeks - 3))
        factor = float(rng.uniform(5.0, 10.0))
        lam[i, week * 7 : (week + 1) * 7] *= factor
        rows.append(
            {
                "sku": cat["sku"].iat[i],
                "location": LOCATION,
                "week_start": week_starts[week],
                "factor": factor,
            }
        )
    return make_table("spikes", rows)


def plant_level_shifts(
    lam: np.ndarray,
    cat: pd.DataFrame,
    week_starts: pd.DatetimeIndex,
    sku_positions: list[int],
    rng: np.random.Generator,
) -> pd.DataFrame:
    """Permanent level shifts: demand x2-3 from a known week onward."""
    n_weeks = len(week_starts)
    rows: list[dict] = []
    for i in sku_positions:
        lo, hi = n_weeks // 3, n_weeks - 13
        if hi <= lo:
            break
        week = int(rng.integers(lo, hi))
        factor = float(rng.uniform(2.0, 3.0))
        lam[i, week * 7 :] *= factor
        rows.append(
            {
                "sku": cat["sku"].iat[i],
                "location": LOCATION,
                "week_start": week_starts[week],
                "factor": factor,
            }
        )
    return make_table("level_shifts", rows)


# --------------------------------------------------------------------------
# transaction-level faults (post tx-build)
# --------------------------------------------------------------------------


def plant_bulk_orders(
    tx: pd.DataFrame,
    cat: pd.DataFrame,
    sku_positions: list[int],
    dates: pd.DatetimeIndex,
    rng: np.random.Generator,
    config: Config,
    blocked_days: frozenset[int] | set[int] = frozenset(),
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Bulk wholesale orders: single order_id, qty > threshold x median line qty.

    Returns (new tx rows, truth table); caller appends the rows.
    """
    mult = float(config.demand.bulk_order_threshold_multiple)
    n_days = len(dates)
    day_lo, day_hi = n_days // 4, n_days - 14
    tx_rows: list[dict] = []
    rows: list[dict] = []
    for j, i in enumerate(sku_positions):
        if day_hi <= day_lo:
            break
        sku = cat["sku"].iat[i]
        med = tx.loc[(tx["sku"] == sku) & (tx["qty"] > 0), "qty"].median()
        if not np.isfinite(med) or med <= 0:
            med = 1.0
        qty = float(np.ceil(med * mult * rng.uniform(1.5, 2.5)))
        day = None
        for _ in range(200):
            cand = int(rng.integers(day_lo, day_hi))
            if cand not in blocked_days:
                day = cand
                break
        if day is None:
            continue
        order_id = f"BULK{j + 1:04d}"
        tx_rows.append(
            {
                "date": dates[day],
                "sku": sku,
                "location": LOCATION,
                "qty": qty,
                "unit_price": float(cat["price"].iat[i]),
                "order_id": order_id,
                "customer_type": "wholesale",
                "line_type": "sale",
            }
        )
        rows.append({"order_id": order_id, "sku": sku, "date": dates[day], "qty": qty})
    return pd.DataFrame(tx_rows), make_table("bulk_orders", rows)


def plant_returns(
    tx: pd.DataFrame,
    skus: list[str],
    dates: pd.DatetimeIndex,
    rng: np.random.Generator,
    blocked_dates: set[pd.Timestamp] | frozenset = frozenset(),
    frac: float = 0.015,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Returns netted late: negative-qty lines 1-3 weeks after a matching sale.

    The return line reuses the sale's order_id, sku and price with negative
    qty and line_type='return'. Return dates are bumped off closure dates.
    Returns (new tx rows, truth table).
    """
    last = dates[-1]
    elig = tx[
        (tx["sku"].isin(skus))
        & (tx["qty"] > 0)
        & (tx["line_type"] == "sale")
        & (tx["customer_type"] == "retail")
        & (tx["date"] <= last - pd.Timedelta(days=25))
    ]
    if elig.empty:
        return pd.DataFrame(), make_table("returns")
    n = min(len(elig), max(3, int(frac * len(elig))))
    pick = np.sort(rng.choice(len(elig), size=n, replace=False))
    lags = rng.integers(7, 22, size=n)  # 1-3 weeks
    tx_rows: list[dict] = []
    rows: list[dict] = []
    for k, (idx, lag) in enumerate(zip(pick, lags)):
        sale = elig.iloc[int(idx)]
        return_date = sale["date"] + pd.Timedelta(days=int(lag))
        while return_date in blocked_dates:
            return_date += pd.Timedelta(days=1)
        if return_date > last:
            continue
        tx_rows.append(
            {
                "date": return_date,
                "sku": sale["sku"],
                "location": LOCATION,
                "qty": -float(sale["qty"]),
                "unit_price": float(sale["unit_price"]),
                "order_id": sale["order_id"],
                "customer_type": "retail",
                "line_type": "return",
            }
        )
        rows.append(
            {
                "order_id": sale["order_id"],
                "sku": sale["sku"],
                "location": LOCATION,
                "sale_date": sale["date"],
                "return_date": return_date,
                "qty": float(sale["qty"]),
            }
        )
    return pd.DataFrame(tx_rows), make_table("returns", rows)


def plant_renames(
    tx: pd.DataFrame,
    cat: pd.DataFrame,
    week_starts: pd.DatetimeIndex,
    sku_positions: list[int],
    rng: np.random.Generator,
) -> tuple[pd.DataFrame, dict[str, str]]:
    """SKU renames mid-history: old sku stops, new sku continues same process.

    Relabels tx lines dated on/after the switch (a week boundary) in place.
    Returns (truth table, {old_sku: new_sku} map for stock/true_rate labels).
    """
    n_weeks = len(week_starts)
    rows: list[dict] = []
    mapping: dict[str, str] = {}
    for i in sku_positions:
        if n_weeks < 24:
            break
        switch_week = int(np.clip(n_weeks // 2 + int(rng.integers(-4, 5)), 14, n_weeks - 8))
        switch_date = week_starts[switch_week]
        old_sku = cat["sku"].iat[i]
        new_sku = f"{old_sku}-R"
        mask = (tx["sku"] == old_sku) & (tx["date"] >= switch_date)
        tx.loc[mask, "sku"] = new_sku
        mapping[old_sku] = new_sku
        rows.append({"old_sku": old_sku, "new_sku": new_sku, "switch_date": switch_date})
    return make_table("renames", rows), mapping
