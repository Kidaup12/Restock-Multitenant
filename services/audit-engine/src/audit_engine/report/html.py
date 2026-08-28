"""HTML report renderer — Jinja2, self-contained output, tolerant context.

`default_context()` produces an empty-but-valid skeleton; `render_report`
deep-merges the caller's context over it, so missing or None keys always
render gracefully (the template additionally guards every section).
"""
from __future__ import annotations

import math
from datetime import datetime
from pathlib import Path

from jinja2 import Environment, FileSystemLoader

_TEMPLATES_DIR = Path(__file__).resolve().parent / "templates"
_TEMPLATE_NAME = "report.html.j2"


# --- formatting filters ------------------------------------------------------

def _bad(v) -> bool:
    if v is None:
        return True
    try:
        f = float(v)
    except (TypeError, ValueError):
        return True
    return math.isnan(f) or math.isinf(f)


def _money(v, symbol: str = "£") -> str:
    if isinstance(v, str):
        return v                       # already formatted upstream
    if _bad(v):
        return "n/a"
    return f"{symbol}{float(v):,.0f}"


def _money_range(low, high, symbol: str = "£") -> str:
    if isinstance(low, str) and high is None:
        return low
    if _bad(low) and _bad(high):
        return "n/a"
    return f"{_money(low, symbol)} – {_money(high, symbol)}"


def _num(v) -> str:
    if isinstance(v, str):
        return v
    if _bad(v):
        return "n/a"
    return f"{float(v):,.0f}"


def _num1(v) -> str:
    if isinstance(v, str):
        return v
    if _bad(v):
        return "n/a"
    return f"{float(v):,.1f}"


def _pct(v) -> str:
    if isinstance(v, str):
        return v
    if _bad(v):
        return "n/a"
    return f"{float(v) * 100:.0f}%"


# --- context -----------------------------------------------------------------

def default_context() -> dict:
    """Empty-but-valid context skeleton. Every key the template reads exists
    here; integrators overwrite whichever sections they have."""
    return {
        "client": "Client",
        "run_id": "",
        "generated": "",
        "currency": "£",
        "exec_summary": {
            "lost_sales_range": None,   # preformatted string, or None to derive from lost_sales.total
            "dead_stock_value": None,   # number or preformatted string
            "capital_tied_up": None,    # number or preformatted string
        },
        "immediate_actions": {
            "runouts": [],              # rows: sku, location, qty_on_hand, baseline_weekly, weeks_of_cover
            "repeat_offenders": [],     # rows: sku, location, episodes, total_days, est_lost_revenue
        },
        "lost_sales": {
            "total": {},                # units_low/units_high/revenue_low/revenue_high/episodes/not_assessable_value_share
            "by_month": [],             # rows: month, lost_units_low/high, lost_revenue_low/high
            "top_skus": [],             # rows: by_sku records (template shows first 20)
            "method_note": None,
        },
        "stock_position": {
            "cover_buckets": [],        # rows: bucket, n_skus, units, value
            "dead_stock": {"buckets": [], "total_value": None, "total_units": None,
                           "threshold_weeks": 8},
            "overstock_value": None,
            "total_stock_value": None,
        },
        "catalogue": {
            "abc": {},                  # {'A': {n_skus, count_share, revenue_share}, ...}
            "top10_revenue_share": None,
            "forecastability": {},      # {'smooth': {n_skus, count_share, revenue_share}, ...}
            "lifecycle": {},            # {'active': n, 'new': n, 'dormant': n}
        },
        "routing": None,                # None -> 'selection pending' note; else {'table': [...], 'note': str}
        "data_quality": {
            "verdict": None,
            "halt_reasons": [],
            "checks": [],               # rows: name, status, detail
            "n_pass": None, "n_flag": None, "n_fail": None,
            "processing": {},           # rows_dropped_total, cells_winsorized, promo_weeks_detected, ...
        },
        "limitations": [],              # list[str] — section 8 renders a default line when empty
        "recommendations": [],          # list[str] or list[{'title','detail'}]
    }


def _merge(base: dict, override: dict | None) -> dict:
    out = dict(base)
    for k, v in (override or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def render_report(context: dict, out_path: Path) -> Path:
    """Render the audit report to a self-contained UTF-8 HTML file."""
    ctx = _merge(default_context(), context)
    if not ctx.get("generated"):
        ctx["generated"] = datetime.now().strftime("%Y-%m-%d %H:%M")
    env = Environment(
        loader=FileSystemLoader(str(_TEMPLATES_DIR)),
        autoescape=True,
    )
    env.filters.update({
        "money": _money,
        "money_range": _money_range,
        "num": _num,
        "num1": _num1,
        "pct": _pct,
    })
    html = env.get_template(_TEMPLATE_NAME).render(**ctx)
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(html, encoding="utf-8")
    return out_path
