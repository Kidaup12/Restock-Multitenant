"""The 17-step cleaning chain, run in strict fixed order (SPEC section 4).

The pipeline owns the AuditLog: every step returns the log rows describing
what it changed, and the pipeline is the only writer. Lines excluded by a
step (duplicates, non-demand types) are split off into the ``excluded`` frame
with a reason; bulk-flagged lines are copied there for reporting but stay in
the panel (flagged, excluded from baseline statistics downstream).
"""
from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from audit_engine.availability.base import AvailabilitySource
from audit_engine.config import Config

from . import steps
from .audit_log import AuditLog
from .steps import EXCLUDE_COL


@dataclass
class CleanResult:
    panel: pd.DataFrame        # PanelSchema
    daily: pd.DataFrame        # (sku, location, date, units) daily spine for stockout inference
    audit_log: pd.DataFrame    # AuditLogSchema
    episodes: pd.DataFrame     # StockoutSchema (from the availability source)
    excluded: pd.DataFrame     # excluded lines w/ reason (bulk, staff, dupes) for reporting


def _empty_episodes() -> pd.DataFrame:
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


def _split_excluded(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame | None]:
    """Pull rows marked with an exclusion reason out of the working frame."""
    if EXCLUDE_COL not in df.columns:
        return df, None
    mask = df[EXCLUDE_COL].notna()
    if not mask.any():
        return df.drop(columns=[EXCLUDE_COL]), None
    ex = df.loc[mask].copy()
    ex["reason"] = ex[EXCLUDE_COL]
    ex = ex.drop(columns=[EXCLUDE_COL])
    keep = df.loc[~mask].drop(columns=[EXCLUDE_COL])
    return keep, ex


def run_chain(
    tx: pd.DataFrame,
    config: Config,
    availability: AvailabilitySource,
    sku_mapping: dict[str, str] | None = None,
    bundle_map: dict[str, list[tuple[str, float]]] | None = None,
) -> CleanResult:
    log = AuditLog()
    excluded_parts: list[pd.DataFrame] = []

    # --- transaction-level steps 1..7 -------------------------------------
    df, rows = steps.step_01_validate(tx, config)
    log.extend(rows)

    df, rows = steps.step_02_dedupe(df, config)
    log.extend(rows)
    df, ex = _split_excluded(df)
    if ex is not None:
        excluded_parts.append(ex)

    df, rows = steps.step_03_apply_sku_mapping(df, config, sku_mapping)
    log.extend(rows)

    df, rows = steps.step_04_exclude_non_demand(df, config)
    log.extend(rows)
    df, ex = _split_excluded(df)
    if ex is not None:
        excluded_parts.append(ex)

    df, rows = steps.step_05_net_returns(df, config)
    log.extend(rows)

    df, rows = steps.step_06_flag_bulk(df, config)
    log.extend(rows)
    bulk_lines = df[df["bulk_line_flag"]]
    if len(bulk_lines):
        # kept in the panel (flagged) but copied to the excluded frame for reporting
        excluded_parts.append(
            bulk_lines.drop(columns=["bulk_line_flag"]).assign(reason="bulk_order")
        )

    df, rows = steps.step_07_explode_bundles(df, config, bundle_map)
    log.extend(rows)

    # --- weekly panel steps 8..17 -----------------------------------------
    weekly, daily, rows = steps.step_08_aggregate(df, config)
    log.extend(rows)

    weekly, rows = steps.step_09_fill_zero_weeks(weekly, config)
    log.extend(rows)

    weekly, rows = steps.step_10_promo_retro(weekly, config)
    log.extend(rows)

    weekly, episodes, rows = steps.step_11_12_availability(weekly, daily, config, availability)
    log.extend(rows)

    weekly, rows = steps.step_13_availability_correction(weekly, config)
    log.extend(rows)

    weekly, rows = steps.step_14_min_coverage(weekly, config)
    log.extend(rows)

    weekly, rows = steps.step_15_winsorize(weekly, config)
    log.extend(rows)

    weekly, rows = steps.step_16_level_shift(weekly, config)
    log.extend(rows)

    panel, rows = steps.step_17_emit(weekly, config)
    log.extend(rows)

    if episodes is None or len(episodes) == 0:
        episodes = _empty_episodes()

    if excluded_parts:
        excluded = pd.concat(excluded_parts, ignore_index=True)
    else:
        cols = [c for c in tx.columns if c != EXCLUDE_COL] + ["reason"]
        excluded = pd.DataFrame({c: pd.Series(dtype=object) for c in cols})

    return CleanResult(
        panel=panel,
        daily=daily,
        audit_log=log.to_frame(),
        episodes=episodes,
        excluded=excluded,
    )
