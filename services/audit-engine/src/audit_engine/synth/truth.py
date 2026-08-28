"""Truth-table assembly for the synthetic generator (SPEC §15).

Every planted fault records its ground truth here so validation tests can
score detection recall / precision against known answers.

``true_rate`` is the *uncensored* weekly demand rate lambda per sku/week —
the rate BEFORE stockout/closure censoring. Demand-level events (promo
uplift, influencer spikes, level shifts) are real demand and ARE included
in it; censoring faults (stockouts, closures) are NOT reflected in it.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

LOCATION = "ALL"

# Canonical column -> dtype for every truth table. Contracts (CONTRACTS.md §B)
# require at least: stockouts(sku, location, start_date, end_date, days),
# closures(date), promos(sku, week_start, uplift), spikes, bulk_orders
# (order_id, sku, date, qty), renames(old_sku, new_sku, switch_date),
# level_shifts(sku, week_start, factor), true_rate(sku, location,
# week_start, lambda_weekly). Extra columns are additive.
TRUTH_COLUMNS: dict[str, dict[str, object]] = {
    "stockouts": {
        "sku": str,
        "location": str,
        "start_date": "datetime64[ns]",
        "end_date": "datetime64[ns]",
        "days": np.int64,
        "lambda_daily": float,  # extra: uncensored mean daily rate over the run
    },
    "closures": {"date": "datetime64[ns]"},
    "promos": {
        "sku": str,
        "location": str,
        "week_start": "datetime64[ns]",
        "uplift": float,            # multiplicative demand factor for the week
        "price_drop_pct": float,    # extra: % below the SKU's modal price (>= threshold)
        "promo_price": float,       # extra: the discounted unit price used that week
    },
    "spikes": {
        "sku": str,
        "location": str,
        "week_start": "datetime64[ns]",
        "factor": float,
    },
    "bulk_orders": {
        "order_id": str,
        "sku": str,
        "date": "datetime64[ns]",
        "qty": float,
    },
    "renames": {
        "old_sku": str,
        "new_sku": str,
        "switch_date": "datetime64[ns]",
    },
    "level_shifts": {
        "sku": str,
        "location": str,
        "week_start": "datetime64[ns]",
        "factor": float,
    },
    "returns": {  # extra table: returns netted late (negative lines 1-3 weeks after sale)
        "order_id": str,
        "sku": str,
        "location": str,
        "sale_date": "datetime64[ns]",
        "return_date": "datetime64[ns]",
        "qty": float,  # the (positive) returned quantity; tx line carries -qty
    },
    "true_rate": {
        "sku": str,
        "location": str,
        "week_start": "datetime64[ns]",
        "lambda_weekly": float,
    },
}


def make_table(key: str, rows: list[dict] | None = None) -> pd.DataFrame:
    """Build a truth table with canonical column order and dtypes."""
    spec = TRUTH_COLUMNS[key]
    if not rows:
        return pd.DataFrame({c: pd.Series(dtype=dt) for c, dt in spec.items()})
    df = pd.DataFrame(rows)
    for c, dt in spec.items():
        if c not in df.columns:
            df[c] = pd.Series(dtype=dt)
        df[c] = df[c].astype(dt)
    return df[list(spec)].reset_index(drop=True)


def empty_truth() -> dict[str, pd.DataFrame]:
    """All truth tables, empty, with correct schemas — always every key present."""
    return {key: make_table(key) for key in TRUTH_COLUMNS}


def true_rate_table(
    skus: list[str], week_starts: pd.DatetimeIndex, lam_weekly: np.ndarray
) -> pd.DataFrame:
    """Long-format uncensored weekly rate table from an (n_sku, n_weeks) matrix."""
    n_sku, n_weeks = lam_weekly.shape
    if n_sku != len(skus) or n_weeks != len(week_starts):
        raise ValueError("lam_weekly shape does not match skus/week_starts")
    df = pd.DataFrame(
        {
            "sku": np.repeat(np.asarray(skus, dtype=object), n_weeks),
            "location": LOCATION,
            "week_start": np.tile(week_starts.to_numpy(), n_sku),
            "lambda_weekly": lam_weekly.astype(float).ravel(),
        }
    )
    return make_table("true_rate", df.to_dict("records")) if df.empty else df


def apply_renames_to_true_rate(
    true_rate: pd.DataFrame, renames: pd.DataFrame
) -> pd.DataFrame:
    """Relabel true_rate rows on/after each switch_date to the new sku name.

    The underlying demand process is unchanged — only the label switches, so
    the truth mirrors what the observed transaction stream calls the SKU.
    """
    out = true_rate.copy()
    for row in renames.itertuples(index=False):
        mask = (out["sku"] == row.old_sku) & (out["week_start"] >= row.switch_date)
        out.loc[mask, "sku"] = row.new_sku
    return out
