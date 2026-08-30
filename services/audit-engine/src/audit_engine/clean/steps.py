"""The 17 ordered preprocessing steps (SPEC section 4).

Each step is a pure-ish function ``(df, config, ...) -> (df, list[LogRow])``;
the pipeline owns the AuditLog, so a step cannot mutate anything without
returning the log rows that describe the mutation. Steps that exclude
transaction lines mark them in the ``_exclude_reason`` column; the pipeline
splits those rows off into the ``excluded`` frame after the step returns.

Steps 8 and 11–12 have slightly wider return tuples (documented on the
functions) because they also produce the daily frame / stockout episodes.

All rolling statistics are imported from ``clean.trailing`` — the only module
allowed to compute them — and are strictly past-only.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from audit_engine.schemas import PanelSchema, TxSchema
from audit_engine.types import LogRow

from .trailing import trailing_median_df, trailing_winsorize

EXCLUDE_COL = "_exclude_reason"

_CONF_RANK = {"high": 3, "medium": 2, "low": 1, "not_assessable": 0, "none": -1}

PANEL_COLUMNS: dict[str, object] = {
    "sku": str,
    "location": str,
    "week_start": "datetime64[ns]",
    "units_raw": float,
    "units_corrected": float,
    "in_stock_days": float,
    "price_median": float,
    "promo_flag": bool,
    "bulk_flag": bool,
    "stockout_flag": bool,
    "stockout_confidence": str,
    "level_shift_flag": bool,
    "filled_zero_flag": bool,
    "usable": bool,
}


def _monday(dates: pd.Series) -> pd.Series:
    """Week start (Monday) for a datetime series."""
    d = pd.to_datetime(dates).dt.normalize()
    return d - pd.to_timedelta(d.dt.weekday, unit="D")


def _monday_scalar(ts) -> pd.Timestamp:
    t = pd.Timestamp(ts).normalize()
    return t - pd.Timedelta(days=t.weekday())


def _iso(ts) -> str:
    return pd.Timestamp(ts).date().isoformat()


def empty_panel() -> pd.DataFrame:
    return pd.DataFrame({c: pd.Series(dtype=t) for c, t in PANEL_COLUMNS.items()})


# ---------------------------------------------------------------------------
# Step 1 — schema validation (halt on failure)
# ---------------------------------------------------------------------------

def step_01_validate(tx: pd.DataFrame, config) -> tuple[pd.DataFrame, list[LogRow]]:
    df = tx.copy()
    if "location" not in df.columns:
        df["location"] = "ALL"
    df["location"] = df["location"].fillna("ALL").astype(str)
    df["sku"] = df["sku"].astype(str)
    df["date"] = pd.to_datetime(df["date"])
    if "unit_price" not in df.columns:
        df["unit_price"] = np.nan
    df = TxSchema.validate(df)  # raises (halts the chain) on failure
    rows = [
        LogRow(1, "schema_validation", f"{len(df)} transaction lines validated against TxSchema")
    ]
    return df, rows


# ---------------------------------------------------------------------------
# Step 2 — deduplicate exact order lines
# ---------------------------------------------------------------------------

def step_02_dedupe(tx: pd.DataFrame, config) -> tuple[pd.DataFrame, list[LogRow]]:
    keys = [
        c
        for c in ("date", "sku", "location", "order_id", "qty", "unit_price")
        if c in tx.columns
    ]
    dup = tx.duplicated(subset=keys, keep="first")
    df = tx.copy()
    n_dup = int(dup.sum())
    if n_dup:
        df.loc[dup, EXCLUDE_COL] = "duplicate"
    rows = [
        LogRow(
            2,
            "dedupe_exact_lines",
            f"{n_dup} exact duplicate lines removed (keys: {', '.join(keys)})",
            value_before=str(len(df)),
            value_after=str(len(df) - n_dup),
        )
    ]
    return df, rows


# ---------------------------------------------------------------------------
# Step 3 — resolve SKU renames via mapping (unmapped = new)
# ---------------------------------------------------------------------------

def step_03_apply_sku_mapping(
    tx: pd.DataFrame, config, sku_mapping: dict[str, str] | None = None
) -> tuple[pd.DataFrame, list[LogRow]]:
    if not sku_mapping:
        return tx, [LogRow(3, "sku_mapping", "no sku mapping supplied; all skus treated as-is")]
    df = tx.copy()
    counts = df["sku"].value_counts()
    rows: list[LogRow] = []
    for old, new in sku_mapping.items():
        n = int(counts.get(old, 0))
        if n:
            rows.append(
                LogRow(
                    3,
                    "sku_rename",
                    f"{n} lines remapped from retired sku",
                    sku=str(old),
                    value_before=str(old),
                    value_after=str(new),
                )
            )
    df["sku"] = df["sku"].replace(sku_mapping)
    if not rows:
        rows.append(LogRow(3, "sku_mapping", "mapping supplied but matched no lines"))
    return df, rows


# ---------------------------------------------------------------------------
# Step 4 — exclude non-demand lines (staff, test, cancelled, fraud)
# ---------------------------------------------------------------------------

def step_04_exclude_non_demand(tx: pd.DataFrame, config) -> tuple[pd.DataFrame, list[LogRow]]:
    excl = {str(x).lower() for x in config.demand.exclude_types}
    line_excl = excl | {"cancelled"}
    df = tx.copy()
    rows: list[LogRow] = []
    if "customer_type" in df.columns:
        m = df["customer_type"].astype(str).str.lower().isin(excl)
        m = m.fillna(False)
        if m.any():
            df.loc[m, EXCLUDE_COL] = "non_demand_customer_type"
            rows.append(
                LogRow(
                    4,
                    "exclude_customer_type",
                    f"{int(m.sum())} lines excluded (customer_type in {sorted(excl)})",
                )
            )
    if "line_type" in df.columns:
        already = df[EXCLUDE_COL].notna() if EXCLUDE_COL in df.columns else pd.Series(False, index=df.index)
        m = df["line_type"].astype(str).str.lower().isin(line_excl) & ~already
        m = m.fillna(False)
        if m.any():
            df.loc[m, EXCLUDE_COL] = "non_demand_line_type"
            rows.append(
                LogRow(
                    4,
                    "exclude_line_type",
                    f"{int(m.sum())} lines excluded (line_type in {sorted(line_excl)})",
                )
            )
    if not rows:
        rows.append(LogRow(4, "exclude_non_demand", "no non-demand lines found"))
    return df, rows


# ---------------------------------------------------------------------------
# Step 5 — net returns to the original sale date
# ---------------------------------------------------------------------------

def step_05_net_returns(tx: pd.DataFrame, config) -> tuple[pd.DataFrame, list[LogRow]]:
    """Move each return (negative qty) line to the date of the most recent
    prior sale of the same sku+location within the netting window (default 8
    weeks, overridable via config.demand.returns_window_weeks). Unmatched
    returns stay at their own date; weekly totals are floored at zero during
    aggregation (step 8) and logged there."""
    df = tx.copy()
    window_weeks = int(getattr(config.demand, "returns_window_weeks", 8))
    ret_mask = df["qty"] < 0
    n_ret = int(ret_mask.sum())
    if n_ret == 0:
        return df, [LogRow(5, "net_returns", "no return lines present")]

    rows: list[LogRow] = []
    sales = (
        df.loc[df["qty"] > 0, ["date", "sku", "location"]]
        .rename(columns={"date": "_sale_date"})
        .sort_values("_sale_date", kind="stable")
    )
    rets = (
        df.loc[ret_mask, ["date", "sku", "location"]]
        .reset_index(names="_ix")
        .sort_values("date", kind="stable")
    )
    if len(sales):
        matched = pd.merge_asof(
            rets,
            sales,
            left_on="date",
            right_on="_sale_date",
            by=["sku", "location"],
            tolerance=pd.Timedelta(days=7 * window_weeks),
            direction="backward",
            allow_exact_matches=True,
        )
    else:
        matched = rets.assign(_sale_date=pd.NaT)

    moved = matched[matched["_sale_date"].notna() & (matched["_sale_date"] != matched["date"])]
    for sku, loc, ret_date, sale_date in zip(
        moved["sku"], moved["location"], moved["date"], moved["_sale_date"]
    ):
        rows.append(
            LogRow(
                5,
                "return_netted_to_sale_date",
                f"return moved to most recent prior sale within {window_weeks}w",
                sku=str(sku),
                location=str(loc),
                week=_iso(_monday_scalar(sale_date)),
                value_before=_iso(ret_date),
                value_after=_iso(sale_date),
            )
        )
    if len(moved):
        df.loc[moved["_ix"].to_numpy(), "date"] = moved["_sale_date"].to_numpy()
    n_unmatched = n_ret - int(matched["_sale_date"].notna().sum())
    rows.append(
        LogRow(
            5,
            "net_returns",
            f"{n_ret} return lines: {len(moved)} moved to prior sale date, "
            f"{n_unmatched} unmatched (subtract at own date)",
        )
    )
    return df, rows


# ---------------------------------------------------------------------------
# Step 6 — flag bulk orders (> multiple x sku median line qty); keep the rows
# ---------------------------------------------------------------------------

def step_06_flag_bulk(tx: pd.DataFrame, config) -> tuple[pd.DataFrame, list[LogRow]]:
    df = tx.copy()
    mult = float(config.demand.bulk_order_threshold_multiple)
    sale = df["qty"] > 0
    rows: list[LogRow] = []
    if sale.any():
        med = df.loc[sale].groupby("sku")["qty"].median()
        thr = (mult * med).reindex(df["sku"]).to_numpy(dtype=float)
        flag = sale.to_numpy() & (df["qty"].to_numpy(dtype=float) > thr)
    else:
        flag = np.zeros(len(df), dtype=bool)
    df["bulk_line_flag"] = flag
    for r in df[df["bulk_line_flag"]].itertuples():
        rows.append(
            LogRow(
                6,
                "bulk_order_flag",
                f"line qty {r.qty} > {mult}x sku median line qty; kept but excluded from baseline stats",
                sku=str(r.sku),
                location=str(r.location),
                week=_iso(_monday_scalar(r.date)),
                value_before=str(r.qty),
            )
        )
    if not rows:
        rows.append(LogRow(6, "bulk_order_flag", "no bulk order lines found"))
    return df, rows


# ---------------------------------------------------------------------------
# Step 7 — explode bundles to components (if bundle map supplied)
# ---------------------------------------------------------------------------

def step_07_explode_bundles(
    tx: pd.DataFrame, config, bundle_map: dict[str, list[tuple[str, float]]] | None = None
) -> tuple[pd.DataFrame, list[LogRow]]:
    if not bundle_map:
        return tx, [LogRow(7, "bundle_explode", "no bundle map supplied")]
    df = tx.copy()
    is_bundle = df["sku"].isin(bundle_map)
    if not is_bundle.any():
        return df, [LogRow(7, "bundle_explode", "bundle map supplied but matched no lines")]
    rows: list[LogRow] = []
    parts = [df[~is_bundle]]
    bundles = df[is_bundle]
    for bundle_sku, components in bundle_map.items():
        sub = bundles[bundles["sku"] == bundle_sku]
        if sub.empty:
            continue
        for comp_sku, mult in components:
            c = sub.copy()
            c["sku"] = comp_sku
            c["qty"] = c["qty"] * float(mult)
            # component-level price allocation is unknowable without a
            # component price list — leave price NaN rather than invent one
            c["unit_price"] = np.nan
            parts.append(c)
        rows.append(
            LogRow(
                7,
                "bundle_explode",
                f"{len(sub)} bundle lines exploded into {len(components)} component skus",
                sku=str(bundle_sku),
                value_before=str(len(sub)),
                value_after=str(len(sub) * len(components)),
            )
        )
    df = pd.concat(parts, ignore_index=True)
    return df, rows


# ---------------------------------------------------------------------------
# Step 8 — aggregate to sku x location x week; build the daily frame
# ---------------------------------------------------------------------------

def step_08_aggregate(tx: pd.DataFrame, config) -> tuple[pd.DataFrame, pd.DataFrame, list[LogRow]]:
    """Returns ``(weekly, daily, log_rows)``.

    weekly: sku, location, week_start (Monday), units_raw, price_median,
    bulk_flag. Weekly totals driven negative by unmatched returns are floored
    at 0 (logged — this completes step 5's netting rule). daily: complete
    daily spine (sku, location, date, units) over each series' first..last
    transaction date, zero-filled, floored at 0 — the stockout-inference input.
    """
    rows: list[LogRow] = []
    if tx.empty:
        weekly = pd.DataFrame(
            {
                "sku": pd.Series(dtype=str),
                "location": pd.Series(dtype=str),
                "week_start": pd.Series(dtype="datetime64[ns]"),
                "units_raw": pd.Series(dtype=float),
                "price_median": pd.Series(dtype=float),
                "bulk_flag": pd.Series(dtype=bool),
            }
        )
        daily = pd.DataFrame(
            {
                "sku": pd.Series(dtype=str),
                "location": pd.Series(dtype=str),
                "date": pd.Series(dtype="datetime64[ns]"),
                "units": pd.Series(dtype=float),
            }
        )
        return weekly, daily, [LogRow(8, "aggregate_weekly", "no transaction lines to aggregate")]

    df = tx.copy()
    df["week_start"] = _monday(df["date"])
    if "bulk_line_flag" not in df.columns:
        df["bulk_line_flag"] = False

    weekly = df.groupby(["sku", "location", "week_start"], as_index=False).agg(
        units_raw=("qty", "sum"), bulk_flag=("bulk_line_flag", "any")
    )
    sale = df[(df["qty"] > 0) & df["unit_price"].notna()]
    if len(sale):
        price = (
            sale.groupby(["sku", "location", "week_start"], as_index=False)["unit_price"]
            .median()
            .rename(columns={"unit_price": "price_median"})
        )
        weekly = weekly.merge(price, on=["sku", "location", "week_start"], how="left")
    else:
        weekly["price_median"] = np.nan

    neg = weekly["units_raw"] < 0
    for r in weekly[neg].itertuples():
        rows.append(
            LogRow(
                8,
                "returns_week_floor_zero",
                "weekly total negative after return netting; floored at 0",
                sku=str(r.sku),
                location=str(r.location),
                week=_iso(r.week_start),
                value_before=str(r.units_raw),
                value_after="0.0",
            )
        )
    weekly.loc[neg, "units_raw"] = 0.0
    weekly["units_raw"] = weekly["units_raw"].astype(float)

    # daily spine per series over first..last transaction date
    df["_day"] = df["date"].dt.normalize()
    dsum = (
        df.groupby(["sku", "location", "_day"], as_index=False)["qty"]
        .sum()
        .rename(columns={"_day": "date", "qty": "units"})
    )
    parts = []
    for (sku, loc), g in dsum.groupby(["sku", "location"], sort=False):
        idx = pd.date_range(g["date"].min(), g["date"].max(), freq="D")
        s = g.set_index("date")["units"].reindex(idx, fill_value=0.0).clip(lower=0.0)
        parts.append(
            pd.DataFrame(
                {"sku": sku, "location": loc, "date": idx, "units": s.to_numpy(dtype=float)}
            )
        )
    daily = pd.concat(parts, ignore_index=True)
    rows.append(
        LogRow(
            8,
            "aggregate_weekly",
            f"{len(weekly)} sku-location-week cells aggregated; {len(daily)} daily spine rows",
        )
    )
    return weekly, daily, rows


# ---------------------------------------------------------------------------
# Step 9 — fill true zeros, only within each series' active lifespan
# ---------------------------------------------------------------------------

def step_09_fill_zero_weeks(weekly: pd.DataFrame, config) -> tuple[pd.DataFrame, list[LogRow]]:
    if weekly.empty:
        out = weekly.copy()
        out["filled_zero_flag"] = pd.Series(dtype=bool)
        return out, [LogRow(9, "fill_true_zeros", "empty panel; nothing to fill")]
    rows: list[LogRow] = []
    parts = []
    for (sku, loc), g in weekly.groupby(["sku", "location"], sort=False):
        weeks = pd.date_range(g["week_start"].min(), g["week_start"].max(), freq="7D")
        full = pd.DataFrame({"sku": sku, "location": loc, "week_start": weeks})
        m = full.merge(g, on=["sku", "location", "week_start"], how="left")
        filled = m["units_raw"].isna()
        m["filled_zero_flag"] = filled.to_numpy()
        m["units_raw"] = m["units_raw"].fillna(0.0).astype(float)
        m["bulk_flag"] = m["bulk_flag"].fillna(False).astype(bool)
        if filled.any():
            rows.append(
                LogRow(
                    9,
                    "fill_true_zeros",
                    f"{int(filled.sum())} missing weeks inside active lifespan "
                    f"[{_iso(weeks[0])}..{_iso(weeks[-1])}] filled with units_raw=0",
                    sku=str(sku),
                    location=str(loc),
                    value_after="0.0",
                )
            )
        parts.append(m)
    out = pd.concat(parts, ignore_index=True)
    if not rows:
        rows.append(LogRow(9, "fill_true_zeros", "no gap weeks inside any active lifespan"))
    return out, rows


# ---------------------------------------------------------------------------
# Step 10 — retro-detect promo weeks from price (past-only trailing median)
# ---------------------------------------------------------------------------

def step_10_promo_retro(weekly: pd.DataFrame, config) -> tuple[pd.DataFrame, list[LogRow]]:
    df = weekly.sort_values(["sku", "location", "week_start"], kind="stable").reset_index(drop=True)
    if df.empty:
        df["promo_flag"] = pd.Series(dtype=bool)
        return df, [LogRow(10, "promo_price_drop", "empty panel; no promo detection")]
    window = int(config.baseline.window_weeks)
    pct = float(config.events.price_drop_threshold_pct)
    trail = trailing_median_df(df, ["sku", "location"], "price_median", window)
    threshold = (1.0 - pct / 100.0) * trail
    promo = df["price_median"].notna() & trail.notna() & (df["price_median"] <= threshold)
    df["promo_flag"] = promo.to_numpy()
    rows: list[LogRow] = []
    for i in np.flatnonzero(df["promo_flag"].to_numpy()):
        r = df.iloc[i]
        rows.append(
            LogRow(
                10,
                "promo_price_drop",
                f"price {r['price_median']:.4g} <= {(1 - pct / 100):.2f}x trailing median "
                f"{trail.iloc[i]:.4g}; week tagged promo",
                sku=str(r["sku"]),
                location=str(r["location"]),
                week=_iso(r["week_start"]),
                value_before=f"{trail.iloc[i]:.6g}",
                value_after=f"{r['price_median']:.6g}",
            )
        )
    if not rows:
        rows.append(LogRow(10, "promo_price_drop", "no promo weeks detected from price"))
    return df, rows


# ---------------------------------------------------------------------------
# Steps 11–12 — stockout inference + in-stock days per week (availability ABC)
# ---------------------------------------------------------------------------

def step_11_12_availability(
    weekly: pd.DataFrame, daily: pd.DataFrame, config, availability
) -> tuple[pd.DataFrame, pd.DataFrame, list[LogRow]]:
    """Returns ``(weekly, episodes, log_rows)``.

    Calls ``availability.in_stock_days(daily, config)``; merges the weekly
    in-stock days, derives stockout_flag / stockout_confidence from the
    returned episodes (a week overlapping an episode inherits the episode's
    confidence; the highest tier wins if several overlap).
    """
    avail_weekly, episodes = availability.in_stock_days(daily, config)
    df = weekly.copy()
    rows: list[LogRow] = []

    if avail_weekly is not None and len(avail_weekly):
        df = df.merge(
            avail_weekly[["sku", "location", "week_start", "in_stock_days"]],
            on=["sku", "location", "week_start"],
            how="left",
        )
    else:
        df["in_stock_days"] = np.nan
    df["in_stock_days"] = df["in_stock_days"].astype(float).fillna(7.0).clip(0.0, 7.0)

    df["stockout_flag"] = False
    df["stockout_confidence"] = "none"

    if episodes is not None and len(episodes):
        marks: dict[tuple, str] = {}
        for ep in episodes.itertuples():
            w0 = _monday_scalar(ep.start_date)
            w1 = _monday_scalar(ep.end_date)
            for w in pd.date_range(w0, w1, freq="7D"):
                key = (ep.sku, ep.location, w)
                if _CONF_RANK.get(str(ep.confidence), 0) > _CONF_RANK.get(marks.get(key, "none"), -1):
                    marks[key] = str(ep.confidence)
            rows.append(
                LogRow(
                    11,
                    "stockout_episode",
                    f"suspected stockout {_iso(ep.start_date)}..{_iso(ep.end_date)} "
                    f"({ep.days} days, p={ep.p_value:.3g}, cross-sectional {ep.cross_sectional_share:.2f})",
                    sku=str(ep.sku),
                    location=str(ep.location),
                    week=_iso(w0),
                    confidence=str(ep.confidence),
                )
            )
        if marks:
            mdf = pd.DataFrame(
                [(k[0], k[1], k[2], v) for k, v in marks.items()],
                columns=["sku", "location", "week_start", "_so_conf"],
            )
            df = df.merge(mdf, on=["sku", "location", "week_start"], how="left")
            hit = df["_so_conf"].notna()
            df.loc[hit, "stockout_flag"] = True
            df.loc[hit, "stockout_confidence"] = df.loc[hit, "_so_conf"]
            df = df.drop(columns=["_so_conf"])
    n_short = int((df["in_stock_days"] < 7).sum())
    rows.append(
        LogRow(
            12,
            "in_stock_days_per_week",
            f"in-stock days merged for {len(df)} weeks; {n_short} weeks below 7 in-stock days; "
            f"{0 if episodes is None else len(episodes)} stockout episodes",
        )
    )
    return df, episodes, rows


# ---------------------------------------------------------------------------
# Step 13 — availability correction (units x 7 / in-stock days, capped)
# ---------------------------------------------------------------------------

def step_13_availability_correction(weekly: pd.DataFrame, config) -> tuple[pd.DataFrame, list[LogRow]]:
    df = weekly.copy()
    cap_mult = float(config.availability.correction_cap_multiple)
    if df.empty:
        df["units_corrected"] = pd.Series(dtype=float)
        return df, [LogRow(13, "availability_correction", "empty panel")]
    isd = df["in_stock_days"].to_numpy(dtype=float)
    raw = df["units_raw"].to_numpy(dtype=float)
    scaled = np.where(isd > 0, raw * 7.0 / np.maximum(isd, 1e-12), np.inf)
    corrected = np.where(isd < 7.0, np.minimum(scaled, cap_mult * raw), raw)
    df["units_corrected"] = corrected.astype(float)
    rows: list[LogRow] = []
    changed = np.flatnonzero(~np.isclose(corrected, raw))
    for i in changed:
        r = df.iloc[i]
        rows.append(
            LogRow(
                13,
                "availability_correction",
                f"units scaled by 7/{isd[i]:.3g} in-stock days, capped at {cap_mult}x raw",
                sku=str(r["sku"]),
                location=str(r["location"]),
                week=_iso(r["week_start"]),
                value_before=f"{raw[i]:.6g}",
                value_after=f"{corrected[i]:.6g}",
                confidence=str(r.get("stockout_confidence", "")),
            )
        )
    if not rows:
        rows.append(LogRow(13, "availability_correction", "no weeks required correction"))
    return df, rows


# ---------------------------------------------------------------------------
# Step 14 — mark weeks below the coverage minimum unusable
# ---------------------------------------------------------------------------

def step_14_min_coverage(weekly: pd.DataFrame, config) -> tuple[pd.DataFrame, list[LogRow]]:
    df = weekly.copy()
    min_days = float(config.availability.min_instock_days_per_week)
    if df.empty:
        df["usable"] = pd.Series(dtype=bool)
        return df, [LogRow(14, "min_coverage", "empty panel")]
    usable = df["in_stock_days"] >= min_days
    df["usable"] = usable.to_numpy()
    rows: list[LogRow] = []
    for i in np.flatnonzero(~df["usable"].to_numpy()):
        r = df.iloc[i]
        rows.append(
            LogRow(
                14,
                "min_coverage",
                f"in_stock_days {r['in_stock_days']:.3g} < {min_days:.3g}; week marked unusable",
                sku=str(r["sku"]),
                location=str(r["location"]),
                week=_iso(r["week_start"]),
                value_before="usable=True",
                value_after="usable=False",
            )
        )
    if not rows:
        rows.append(LogRow(14, "min_coverage", "all weeks meet the in-stock coverage minimum"))
    return df, rows


# ---------------------------------------------------------------------------
# Step 15 — winsorize untagged spikes at multiple x trailing median
# ---------------------------------------------------------------------------

def step_15_winsorize(weekly: pd.DataFrame, config) -> tuple[pd.DataFrame, list[LogRow]]:
    df = weekly.sort_values(["sku", "location", "week_start"], kind="stable").reset_index(drop=True)
    if df.empty:
        df["units_precap"] = pd.Series(dtype=float)
        df["winsorize_capped_flag"] = pd.Series(dtype=bool)
        return df, [LogRow(15, "winsorize_trailing_cap", "empty panel")]
    window = int(config.baseline.window_weeks)
    mult = float(config.baseline.winsorize_multiple)
    df["units_precap"] = df["units_corrected"].astype(float)
    df["winsorize_capped_flag"] = False
    rows: list[LogRow] = []
    for (sku, loc), g in df.groupby(["sku", "location"], sort=False):
        skip = (g["promo_flag"] | g["bulk_flag"]).to_numpy(dtype=bool)
        vals, capped = trailing_winsorize(
            g["units_corrected"].to_numpy(dtype=float), window, mult, skip_mask=skip
        )
        df.loc[g.index, "units_corrected"] = vals
        df.loc[g.index, "winsorize_capped_flag"] = capped
        for pos in np.flatnonzero(capped):
            ix = g.index[pos]
            rows.append(
                LogRow(
                    15,
                    "winsorize_trailing_cap",
                    f"untagged spike capped at {mult}x trailing {window}w median",
                    sku=str(sku),
                    location=str(loc),
                    week=_iso(df.at[ix, "week_start"]),
                    value_before=f"{df.at[ix, 'units_precap']:.6g}",
                    value_after=f"{df.at[ix, 'units_corrected']:.6g}",
                )
            )
    if not rows:
        rows.append(LogRow(15, "winsorize_trailing_cap", "no untagged spikes above the cap"))
    return df, rows


# ---------------------------------------------------------------------------
# Step 16 — level-shift detection (consecutive capped weeks -> un-cap onward)
# ---------------------------------------------------------------------------

def step_16_level_shift(weekly: pd.DataFrame, config) -> tuple[pd.DataFrame, list[LogRow]]:
    df = weekly.sort_values(["sku", "location", "week_start"], kind="stable").reset_index(drop=True)
    n_consec = int(config.baseline.level_shift_consecutive_weeks)
    if df.empty:
        df["level_shift_flag"] = pd.Series(dtype=bool)
        return df, [LogRow(16, "level_shift", "empty panel")]
    df["level_shift_flag"] = False
    rows: list[LogRow] = []
    for (sku, loc), g in df.groupby(["sku", "location"], sort=False):
        capped = g["winsorize_capped_flag"].to_numpy(dtype=bool)
        run = 0
        shift_pos: int | None = None
        for i, c in enumerate(capped):
            run = run + 1 if c else 0
            if run >= n_consec:
                shift_pos = i - n_consec + 1
                break
        if shift_pos is None:
            continue
        shift_week = g.iloc[shift_pos]["week_start"]
        onward = g.index[shift_pos:]
        restore = onward[capped[shift_pos:]]
        for ix in restore:
            rows.append(
                LogRow(
                    16,
                    "level_shift_uncap",
                    f"{n_consec}+ consecutive weeks at winsorize cap from {_iso(shift_week)}; "
                    "cap removed (trailing median will catch up)",
                    sku=str(sku),
                    location=str(loc),
                    week=_iso(df.at[ix, "week_start"]),
                    value_before=f"{df.at[ix, 'units_corrected']:.6g}",
                    value_after=f"{df.at[ix, 'units_precap']:.6g}",
                )
            )
        df.loc[restore, "units_corrected"] = df.loc[restore, "units_precap"]
        df.loc[restore, "winsorize_capped_flag"] = False
        df.loc[onward, "level_shift_flag"] = True
        rows.append(
            LogRow(
                16,
                "level_shift_detected",
                f"level shift detected at {_iso(shift_week)}: {len(restore)} weeks un-capped, "
                "level_shift_flag set from shift start onward",
                sku=str(sku),
                location=str(loc),
                week=_iso(shift_week),
            )
        )
    if not rows:
        rows.append(LogRow(16, "level_shift", "no level shifts detected"))
    return df, rows


# ---------------------------------------------------------------------------
# Step 17 — validate and emit the clean panel
# ---------------------------------------------------------------------------

def step_17_emit(weekly: pd.DataFrame, config) -> tuple[pd.DataFrame, list[LogRow]]:
    df = weekly.copy()
    if df.empty:
        panel = empty_panel()
        panel = PanelSchema.validate(panel)
        return panel, [LogRow(17, "emit_clean_panel", "empty panel emitted")]
    df = df.drop(columns=["units_precap"], errors="ignore")
    for col, default in [
        ("promo_flag", False),
        ("bulk_flag", False),
        ("stockout_flag", False),
        ("level_shift_flag", False),
        ("filled_zero_flag", False),
        ("usable", True),
    ]:
        if col not in df.columns:
            df[col] = default
        df[col] = df[col].fillna(default).astype(bool)
    if "stockout_confidence" not in df.columns:
        df["stockout_confidence"] = "none"
    df["stockout_confidence"] = df["stockout_confidence"].fillna("none").astype(str)
    if "price_median" not in df.columns:
        df["price_median"] = np.nan
    ordered = [c for c in PANEL_COLUMNS] + [
        c for c in df.columns if c not in PANEL_COLUMNS
    ]
    df = df[ordered]
    df = df.sort_values(["sku", "location", "week_start"], kind="stable").reset_index(drop=True)
    df = PanelSchema.validate(df)
    n_series = df[["sku", "location"]].drop_duplicates().shape[0]
    rows = [
        LogRow(
            17,
            "emit_clean_panel",
            f"clean panel emitted: {len(df)} sku-location-weeks across {n_series} series",
        )
    ]
    return df, rows
