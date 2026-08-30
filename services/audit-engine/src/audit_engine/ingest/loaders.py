"""Tolerant CSV loaders for client sales and stock exports.

Real POS exports arrive with inconsistent column names ("Order Date", "Qty",
"unit price"), ambiguous date formats (dd/mm vs mm/dd), currency symbols in
price columns, blank padding rows, and duplicated lines. The loaders normalise
all of that into TxSchema / StockSchema frames; anything they cannot fix they
either drop (junk rows) or surface loudly (missing required columns).

Dayfirst detection is sample-based: if any date value in the file is only
parseable with day-first ordering (first component > 12), the whole file is
parsed dayfirst. ISO dates (yyyy-mm-dd) are unaffected either way.
"""
from __future__ import annotations

import re
from pathlib import Path

import pandas as pd

from audit_engine.config import Config
from audit_engine.schemas import StockSchema, TxSchema

# --- column aliasing --------------------------------------------------------

# canonical name -> normalised alias spellings (lowercase, spaces/hyphens -> _)
_SALES_ALIASES: dict[str, set[str]] = {
    "date": {"date", "order_date", "orderdate", "sale_date", "sales_date", "txn_date",
             "transaction_date", "invoice_date", "day", "created_at", "datetime"},
    "sku": {"sku", "matched_sku", "product_code", "productcode", "item", "item_code", "item_no",
            "item_number", "product", "product_id", "article", "variant_sku", "stock_code"},
    "location": {"location", "store", "site", "branch", "shop", "warehouse", "outlet",
                 "store_name", "location_name"},
    "qty": {"qty", "quantity", "units", "qty_sold", "quantity_sold", "units_sold",
            "net_quantity", "no_of_units"},
    "unit_price": {"unit_price", "price", "unitprice", "selling_price", "sale_price",
                   "price_per_unit", "price_per_item", "item_price", "net_price", "gross_price"},
    "discount": {"discount", "discount_amount", "line_discount", "discount_value"},
    "order_id": {"order_id", "order", "order_no", "order_number", "orderid", "receipt",
                 "receipt_no", "invoice", "invoice_no", "transaction_id", "txn_id", "basket_id"},
    "customer_type": {"customer_type", "cust_type", "customer_group", "account_type"},
    "line_type": {"line_type", "type", "sale_type", "transaction_type", "row_type"},
    "channel": {"channel", "sales_channel", "source"},
    "category": {"category", "product_type", "product_category", "dept", "department",
                 "product_group", "cat", "brand"},
}

_STOCK_ALIASES: dict[str, set[str]] = {
    "sku": _SALES_ALIASES["sku"],
    "location": _SALES_ALIASES["location"],
    "qty_on_hand": {"qty_on_hand", "on_hand", "onhand", "stock", "stock_on_hand", "soh",
                    "quantity_on_hand", "qty", "quantity", "units", "available",
                    "stock_level", "current_stock", "in_stock"},
    "unit_cost": {"unit_cost", "cost", "unitcost", "cost_price", "cost_per_unit",
                  "avg_cost", "average_cost", "landed_cost"},
    "category": _SALES_ALIASES["category"],
}

_SALES_REQUIRED = ["date", "sku", "qty"]
_STOCK_REQUIRED = ["sku", "qty_on_hand"]

_CURRENCY_RE = re.compile(r"[£$€,\s]")
_DMY_RE = re.compile(r"^\s*(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\s*$")


def _normalise(name: str) -> str:
    """Lowercase, trim, collapse spaces/hyphens/dots to underscores."""
    return re.sub(r"[\s\-.]+", "_", str(name).strip().lower()).strip("_")


def _resolve_columns(
    raw_columns: list[str],
    aliases: dict[str, set[str]],
    column_map: dict[str, str] | None,
) -> dict[str, str]:
    """Map raw column names -> canonical names. Explicit column_map wins;
    aliases matched case/space-insensitively. First match per canonical wins."""
    rename: dict[str, str] = {}
    claimed: set[str] = set()
    explicit = column_map or {}
    explicit_norm = {_normalise(k): v for k, v in explicit.items()}
    for col in raw_columns:
        target = explicit.get(col) or explicit_norm.get(_normalise(col))
        if target and target not in claimed:
            rename[col] = target
            claimed.add(target)
    for col in raw_columns:
        if col in rename:
            continue
        norm = _normalise(col)
        for canonical, names in aliases.items():
            if canonical in claimed:
                continue
            if norm == canonical or norm in names:
                rename[col] = canonical
                claimed.add(canonical)
                break
    return rename


def _detect_dayfirst(values: pd.Series) -> bool:
    """True when at least one value is only valid with day-first ordering
    (numeric first component > 12). ISO and unambiguous values leave the
    default (month-first) in place."""
    for v in values.dropna().astype(str):
        m = _DMY_RE.match(v)
        if m and int(m.group(1)) > 12:
            return True
    return False


def _clean_str(series: pd.Series) -> pd.Series:
    """Trim whitespace; keep missing values as NA (never the string 'nan')."""
    s = series.astype("string").str.strip()
    return s.replace({"nan": None, "None": None})


def _location_or_all(df: pd.DataFrame) -> pd.Series:
    """Location column trimmed, with missing/blank values defaulting to 'ALL'."""
    if "location" not in df.columns:
        return pd.Series("ALL", index=df.index, dtype=str)
    loc = _clean_str(df["location"])
    return loc.where(loc.notna() & (loc != ""), "ALL").astype(str)


def _to_numeric(series: pd.Series) -> pd.Series:
    """Numeric coercion tolerant of currency symbols and thousands separators."""
    cleaned = series.astype("string").str.replace(_CURRENCY_RE, "", regex=True)
    cleaned = cleaned.replace({"": None, "nan": None, "None": None})
    return pd.to_numeric(cleaned, errors="coerce")


def _read_csv(path: str | Path) -> pd.DataFrame:
    df = pd.read_csv(path, dtype=str, skip_blank_lines=True)
    df.columns = [str(c) for c in df.columns]
    # drop rows where every cell is blank/NaN (padding rows in exports)
    stripped = df.apply(lambda c: c.str.strip() if c.dtype == object else c)
    return df[~stripped.isna().all(axis=1) & ~(stripped.fillna("") == "").all(axis=1)].copy()


def _missing_error(kind: str, missing: list[str], found: list[str]) -> ValueError:
    return ValueError(
        f"{kind} file is missing required column(s): {missing}. "
        f"Columns found: {found}. Pass column_map={{'<your column>': '<canonical>'}} "
        f"to map non-standard names."
    )


def load_sales(
    path: str | Path,
    config: Config,
    column_map: dict[str, str] | None = None,
) -> pd.DataFrame:
    """Load a transaction-level sales CSV into a TxSchema-validated frame.

    - Column aliasing (case/space-insensitive) for common POS export names,
      overridable via ``column_map`` ({raw_name: canonical_name}).
    - Sample-based dayfirst detection: if >0 rows parse only as day-first,
      the whole file is parsed dayfirst.
    - ``location`` defaults to 'ALL' when absent/blank (single-site).
    - qty / unit_price / discount coerced to numeric (currency symbols stripped).
    - Rows with an unparseable date, blank sku, or non-numeric qty are dropped
      (they are export junk, not demand).
    """
    df = _read_csv(path)
    rename = _resolve_columns(list(df.columns), _SALES_ALIASES, column_map)
    df = df.rename(columns=rename)

    missing = [c for c in _SALES_REQUIRED if c not in df.columns]
    if missing:
        raise _missing_error("sales", missing, list(pd.read_csv(path, nrows=0).columns))

    dayfirst = _detect_dayfirst(df["date"])
    df["date"] = pd.to_datetime(df["date"], errors="coerce", dayfirst=dayfirst)
    df["qty"] = _to_numeric(df["qty"])
    df["sku"] = _clean_str(df["sku"])

    if "unit_price" in df.columns:
        df["unit_price"] = _to_numeric(df["unit_price"])
    else:
        df["unit_price"] = float("nan")
    if "discount" in df.columns:
        df["discount"] = _to_numeric(df["discount"])

    df["location"] = _location_or_all(df)

    for col in ("order_id", "customer_type", "line_type", "channel", "category"):
        if col in df.columns:
            df[col] = _clean_str(df[col]).replace({"": None})

    # drop junk rows the coercions could not rescue
    df = df[df["date"].notna() & df["qty"].notna() & df["sku"].notna() & (df["sku"] != "")]
    df = df.reset_index(drop=True)

    keep = [c for c in TxSchema.columns if c in df.columns]
    return TxSchema.validate(df[keep])


def load_stock(
    path: str | Path,
    config: Config,
    column_map: dict[str, str] | None = None,
) -> pd.DataFrame:
    """Load a current stock-on-hand CSV into a StockSchema-validated frame.

    Same aliasing/coercion rules as :func:`load_sales`. Negative on-hand
    quantities are clamped to 0 and flagged in the boolean column
    ``_negative_stock_clamped`` (SPEC §3: treat as zero, flag).
    """
    df = _read_csv(path)
    rename = _resolve_columns(list(df.columns), _STOCK_ALIASES, column_map)
    df = df.rename(columns=rename)

    missing = [c for c in _STOCK_REQUIRED if c not in df.columns]
    if missing:
        raise _missing_error("stock", missing, list(pd.read_csv(path, nrows=0).columns))

    df["sku"] = _clean_str(df["sku"])
    df["qty_on_hand"] = _to_numeric(df["qty_on_hand"])
    if "unit_cost" in df.columns:
        df["unit_cost"] = _to_numeric(df["unit_cost"])
    else:
        df["unit_cost"] = float("nan")

    df["location"] = _location_or_all(df)

    df = df[df["qty_on_hand"].notna() & df["sku"].notna() & (df["sku"] != "")]
    df = df.reset_index(drop=True)

    df["_negative_stock_clamped"] = df["qty_on_hand"] < 0
    df.loc[df["_negative_stock_clamped"], "qty_on_hand"] = 0.0

    keep = [c for c in StockSchema.columns if c in df.columns] + ["_negative_stock_clamped"]
    if "category" in df.columns:
        keep.append("category")
    return StockSchema.validate(df[keep])
