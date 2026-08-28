"""SKU-level detail workbook: one tab per finding, via xlsxwriter.

Frozen bold header row, autofilter, content-derived column widths, and
sensible number formats (2dp for money-named columns, 1dp for cover,
thousands-separated integers for counts).
"""
from __future__ import annotations

import datetime as _dt
from pathlib import Path

import numpy as np
import pandas as pd
import xlsxwriter

_MONEY_HINTS = ("revenue", "value", "cost", "price")
_INT_HINTS = ("days", "episodes", "count", "units", "qty", "n_skus")
_INVALID_SHEET_CHARS = set("[]:*?/\\")
_MAX_SHEET_NAME = 31


def _sheet_name(name: str, used: set[str]) -> str:
    s = "".join("_" if ch in _INVALID_SHEET_CHARS else ch for ch in str(name)).strip()
    s = (s or "Sheet")[:_MAX_SHEET_NAME]
    base, k = s, 1
    while s.lower() in used:
        s = f"{base[:_MAX_SHEET_NAME - len(str(k)) - 1]}_{k}"
        k += 1
    used.add(s.lower())
    return s


def _col_format(name: str, dtype, fmts: dict):
    n = str(name).lower()
    if any(h in n for h in _MONEY_HINTS):
        return fmts["money"]
    if "cover" in n or "weeks" in n:
        return fmts["one_dp"]
    if pd.api.types.is_integer_dtype(dtype):
        return fmts["int"]
    if any(h in n for h in _INT_HINTS):
        return fmts["int"]
    return None


def _col_width(name: str, series: pd.Series) -> float:
    w = len(str(name))
    if len(series):
        try:
            w = max(w, int(series.head(200).astype(str).str.len().max()))
        except Exception:
            pass
    return float(min(max(w + 2, 8), 50))


def write_workbook(out_path: Path, sheets: dict[str, pd.DataFrame]) -> Path:
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    wb = xlsxwriter.Workbook(str(out_path), {"nan_inf_to_errors": True})
    fmts = {
        "header": wb.add_format({"bold": True, "bottom": 1, "bg_color": "#F2F2F2"}),
        "money": wb.add_format({"num_format": "#,##0.00"}),
        "one_dp": wb.add_format({"num_format": "0.0"}),
        "int": wb.add_format({"num_format": "#,##0"}),
        "date": wb.add_format({"num_format": "yyyy-mm-dd"}),
    }
    used: set[str] = set()
    try:
        for name, df in sheets.items():
            ws = wb.add_worksheet(_sheet_name(name, used))
            if df is None:
                df = pd.DataFrame()
            cols = list(df.columns)
            for j, c in enumerate(cols):
                ws.write_string(0, j, str(c), fmts["header"])
            ws.freeze_panes(1, 0)
            if cols:
                ws.autofilter(0, 0, max(len(df), 1), len(cols) - 1)
            for j, c in enumerate(cols):
                series = df[c]
                is_dt = pd.api.types.is_datetime64_any_dtype(series.dtype)
                fmt = fmts["date"] if is_dt else _col_format(c, series.dtype, fmts)
                ws.set_column(j, j, _col_width(c, series), fmt)
                for i, v in enumerate(series, start=1):
                    try:
                        if pd.isna(v):
                            continue
                    except (TypeError, ValueError):
                        pass
                    if isinstance(v, pd.Timestamp):
                        ws.write_datetime(i, j, v.to_pydatetime(), fmts["date"])
                    elif isinstance(v, (_dt.datetime, _dt.date)):
                        ws.write_datetime(i, j, v, fmts["date"])
                    elif isinstance(v, (bool, np.bool_)):
                        ws.write_boolean(i, j, bool(v))
                    elif isinstance(v, (int, float, np.integer, np.floating)):
                        ws.write_number(i, j, float(v))
                    else:
                        ws.write_string(i, j, str(v))
    finally:
        wb.close()
    return out_path
