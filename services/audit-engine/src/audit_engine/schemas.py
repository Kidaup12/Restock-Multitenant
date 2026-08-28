"""Pandera schemas — the data contracts between modules.

Every DataFrame that crosses a module boundary is validated against one of
these. Columns marked nullable are genuinely optional in client data; the
loaders normalise column names/dtypes before validation.
"""
from __future__ import annotations

import pandera.pandas as pa
from pandera.pandas import Column, DataFrameSchema

CONFIDENCE_TIERS = ["high", "medium", "low", "not_assessable"]

# --- raw inputs (post-loader normalisation) --------------------------------

TxSchema = DataFrameSchema(
    {
        "date": Column("datetime64[ns]"),
        "sku": Column(str),
        "location": Column(str),                       # 'ALL' when single-site
        "qty": Column(float, coerce=True),             # negative = return
        "unit_price": Column(float, nullable=True, coerce=True),
        "discount": Column(float, nullable=True, coerce=True, required=False),
        "order_id": Column(str, nullable=True, required=False),
        "customer_type": Column(str, nullable=True, required=False),
        "line_type": Column(str, nullable=True, required=False),
        "channel": Column(str, nullable=True, required=False),
        "category": Column(str, nullable=True, required=False),
    },
    coerce=True,
    strict=False,
)

StockSchema = DataFrameSchema(
    {
        "sku": Column(str),
        "location": Column(str),
        "qty_on_hand": Column(float, coerce=True),
        "unit_cost": Column(float, nullable=True, coerce=True),
    },
    coerce=True,
    strict=False,
)

# --- clean panel (output of the 17-step chain) -----------------------------

PanelSchema = DataFrameSchema(
    {
        "sku": Column(str),
        "location": Column(str),
        "week_start": Column("datetime64[ns]"),
        "units_raw": Column(float, coerce=True),
        "units_corrected": Column(float, coerce=True),
        "in_stock_days": Column(float, pa.Check.in_range(0, 7), coerce=True),
        "price_median": Column(float, nullable=True, coerce=True),
        "promo_flag": Column(bool, coerce=True),
        "bulk_flag": Column(bool, coerce=True),
        "stockout_flag": Column(bool, coerce=True),
        "stockout_confidence": Column(str, pa.Check.isin(CONFIDENCE_TIERS + ["none"])),
        "level_shift_flag": Column(bool, coerce=True),
        "filled_zero_flag": Column(bool, coerce=True),
        "usable": Column(bool, coerce=True),
    },
    coerce=True,
    strict=False,
)

# --- audit log --------------------------------------------------------------

AuditLogSchema = DataFrameSchema(
    {
        "sku": Column(str, nullable=True),
        "location": Column(str, nullable=True),
        "week": Column(str, nullable=True),            # ISO date or '' for file-level rules
        "step_number": Column(int, coerce=True),
        "rule_name": Column(str),
        "value_before": Column(str, nullable=True),
        "value_after": Column(str, nullable=True),
        "reason": Column(str),
        "confidence": Column(str, nullable=True),
    },
    coerce=True,
    strict=False,
)

# --- stockout episodes (availability/inferred output) ----------------------

StockoutSchema = DataFrameSchema(
    {
        "sku": Column(str),
        "location": Column(str),
        "start_date": Column("datetime64[ns]"),
        "end_date": Column("datetime64[ns]"),
        "days": Column(int, coerce=True),
        "confidence": Column(str, pa.Check.isin(CONFIDENCE_TIERS)),
        "p_value": Column(float, coerce=True),
        "cross_sectional_share": Column(float, coerce=True),
    },
    coerce=True,
    strict=False,
)

# --- baseline ---------------------------------------------------------------

BaselineSchema = DataFrameSchema(
    {
        "sku": Column(str),
        "location": Column(str),
        "baseline_weekly": Column(float, nullable=True, coerce=True),
        "baseline_daily": Column(float, nullable=True, coerce=True),
        "usable_weeks": Column(int, coerce=True),
        "method": Column(str),   # own | cluster_analog | dormant | launch | not_assessable
        "confidence": Column(str),
    },
    coerce=True,
    strict=False,
)

# --- segmentation -----------------------------------------------------------

SegmentSchema = DataFrameSchema(
    {
        "sku": Column(str),
        "location": Column(str),
        "abc": Column(str, pa.Check.isin(["A", "B", "C"])),
        "xyz": Column(str, pa.Check.isin(["X", "Y", "Z"])),
        "adi": Column(float, nullable=True, coerce=True),
        "cv2": Column(float, nullable=True, coerce=True),
        "demand_class": Column(str, pa.Check.isin(["smooth", "intermittent", "erratic", "lumpy"])),
        "intermittent_flag": Column(bool, coerce=True),
        "lifecycle": Column(str, pa.Check.isin(["active", "new", "dormant"])),
        "segment": Column(str),  # routing cell, e.g. 'AX', 'intermittent', 'new', 'dormant'
    },
    coerce=True,
    strict=False,
)

# --- model scores (selection harness output) -------------------------------

ScoreSchema = DataFrameSchema(
    {
        "block": Column(str, pa.Check.isin(["selection", "validation"])),
        "origin_date": Column("datetime64[ns]"),
        "model_id": Column(str),
        "sku": Column(str),
        "location": Column(str),
        "horizon": Column(int, coerce=True),
        "y_true": Column(float, nullable=True, coerce=True),
        "y_pred": Column(float, nullable=True, coerce=True),
        "scored": Column(bool, coerce=True),
        "exclusion_reason": Column(str, nullable=True),
    },
    coerce=True,
    strict=False,
)
