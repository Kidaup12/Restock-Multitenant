"""Phase 0 data health audit (SPEC §3).

Runs before anything else. Produces a HealthReport: a go/no-go verdict plus
one HealthCheck per SPEC §3 table row. Only the four SPEC go/no-go conditions
halt; every other problem is a flag and a finding, never a stop.

Zero-vs-null ambiguity (implemented in ``_check_zero_vs_null``):
    For each SKU, take its active span (first sale week -> last sale week,
    inclusive, in calendar weeks). Count the calendar weeks inside that span
    with no sales rows at all ("absent weeks"). Estimate the SKU's mean weekly
    sale rate as total positive units sold / span weeks. Under a Poisson
    assumption the probability that a week with that rate is a *true* zero is
    P(no sale) = exp(-mean_weekly_rate). When P < 0.05 an absent week is
    unlikely to be a genuine zero - it is more plausibly a missing row - so
    every absent week of that SKU counts as *ambiguous*. The reported figure
    is the share of ambiguous weeks across all SKU-span weeks in the
    catalogue. Above ``config.data_quality.max_null_zero_ambiguity_pct`` the
    file cannot distinguish "did not sell" from "was not recorded" and the
    audit halts.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from audit_engine.config import Config
from audit_engine.types import HealthCheck, HealthReport

# SPEC §3: price availability below this % -> no money figures (not in config)
_PRICE_AVAILABILITY_MIN_PCT = 80.0
# SPEC §3: catalogue mismatch above this % -> flag (not in config)
_CATALOGUE_MISMATCH_FLAG_PCT = 10.0
# SPEC §7.7 window convention: "suspiciously recent" first sale for truncation check
_TRUNCATION_RECENT_WEEKS = 12
_TRUNCATION_MIN_SPAN_WEEKS = 26
# Poisson threshold for "an absent week is unlikely to be a true zero"
_AMBIGUOUS_P_ZERO = 0.05


def _week_start(dates: pd.Series) -> pd.Series:
    """Floor dates to the Monday of their week (config week_start is monday)."""
    d = dates.dt.normalize()
    return d - pd.to_timedelta(d.dt.dayofweek, unit="D")


def _sku_week_stats(tx: pd.DataFrame) -> pd.DataFrame:
    """Per-SKU: first/last week, span weeks, distinct weeks with rows, units."""
    t = tx.copy()
    t["week"] = _week_start(t["date"])
    g = t.groupby("sku")
    stats = pd.DataFrame(
        {
            "first_week": g["week"].min(),
            "last_week": g["week"].max(),
            "present_weeks": g["week"].nunique(),
            "units": g["qty"].apply(lambda q: float(q[q > 0].sum())),
        }
    )
    stats["span_weeks"] = ((stats["last_week"] - stats["first_week"]).dt.days // 7) + 1
    return stats


# --- individual checks ------------------------------------------------------


def _check_history_depth(stats: pd.DataFrame, config: Config) -> tuple[HealthCheck, str | None]:
    spans = stats["span_weeks"]
    median_weeks = float(spans.median()) if len(spans) else 0.0
    n = max(len(spans), 1)
    metrics = {
        "median_weeks": median_weeks,
        "pct_ge_104w": round(100.0 * (spans >= 104).sum() / n, 1),
        "pct_ge_52w": round(100.0 * (spans >= 52).sum() / n, 1),
        "pct_ge_26w": round(100.0 * (spans >= 26).sum() / n, 1),
        "pct_lt_26w": round(100.0 * (spans < 26).sum() / n, 1),
        "n_skus": len(spans),
    }
    min_weeks = config.data_quality.min_median_history_weeks
    if median_weeks < min_weeks:
        halt = (
            f"median SKU history is {median_weeks:.0f} weeks, below the "
            f"minimum of {min_weeks} weeks"
        )
        return HealthCheck("history_depth", "fail", halt, metrics), halt
    status = "pass" if median_weeks >= 26 else "flag"
    detail = (
        f"median history {median_weeks:.0f}w; "
        f"{metrics['pct_ge_52w']}% of SKUs have >=52w, "
        f"{metrics['pct_lt_26w']}% have <26w"
    )
    return HealthCheck("history_depth", status, detail, metrics), None


def _check_zero_vs_null(tx: pd.DataFrame, stats: pd.DataFrame, config: Config) -> tuple[HealthCheck, str | None]:
    """See module docstring for the ambiguity definition."""
    rate = stats["units"] / stats["span_weeks"]
    absent = (stats["span_weeks"] - stats["present_weeks"]).clip(lower=0)
    p_true_zero = np.exp(-rate)
    ambiguous = absent.where(p_true_zero < _AMBIGUOUS_P_ZERO, 0)
    total_weeks = int(stats["span_weeks"].sum())
    ambiguous_weeks = int(ambiguous.sum())
    pct = 100.0 * ambiguous_weeks / total_weeks if total_weeks else 0.0
    metrics = {
        "ambiguous_weeks": ambiguous_weeks,
        "absent_weeks": int(absent.sum()),
        "total_span_weeks": total_weeks,
        "ambiguous_pct": round(pct, 2),
        "n_skus_affected": int((ambiguous > 0).sum()),
    }
    max_pct = config.data_quality.max_null_zero_ambiguity_pct
    if pct > max_pct:
        halt = (
            f"{pct:.1f}% of SKU-weeks are ambiguous zero-vs-null, above the "
            f"{max_pct}% maximum - absent weeks cannot be trusted as true zeros"
        )
        return HealthCheck("zero_vs_null", "fail", halt, metrics), halt
    if ambiguous_weeks > 0:
        return HealthCheck(
            "zero_vs_null", "flag",
            f"{ambiguous_weeks} weeks ({pct:.1f}%) are ambiguous zero-vs-null",
            metrics,
        ), None
    return HealthCheck("zero_vs_null", "pass", "absent weeks consistent with true zeros", metrics), None


def _check_catalogue_coverage(tx: pd.DataFrame, stock: pd.DataFrame | None) -> tuple[HealthCheck, str | None]:
    if stock is None or len(stock) == 0:
        return HealthCheck(
            "catalogue_coverage", "flag",
            "no stock file supplied - coverage vs catalogue not assessable", {},
        ), None
    sales_skus = set(tx["sku"].unique())
    stock_skus = set(stock["sku"].unique())
    overlap = sales_skus & stock_skus
    sales_only = sales_skus - stock_skus
    stock_only = stock_skus - sales_skus
    union = sales_skus | stock_skus
    mismatch_pct = 100.0 * (len(sales_only) + len(stock_only)) / len(union) if union else 0.0
    metrics = {
        "sales_skus": len(sales_skus),
        "stock_skus": len(stock_skus),
        "overlap": len(overlap),
        "in_sales_not_stock": len(sales_only),
        "in_stock_not_sales": len(stock_only),
        "mismatch_pct": round(mismatch_pct, 1),
    }
    if sales_skus and stock_skus and not overlap:
        halt = "sales file and stock catalogue share no SKUs - completely unreconcilable"
        return HealthCheck("catalogue_coverage", "fail", halt, metrics), halt
    if mismatch_pct > _CATALOGUE_MISMATCH_FLAG_PCT:
        return HealthCheck(
            "catalogue_coverage", "flag",
            f"{mismatch_pct:.0f}% SKU mismatch between sales and stock "
            f"({len(sales_only)} only in sales, {len(stock_only)} only in stock)",
            metrics,
        ), None
    return HealthCheck("catalogue_coverage", "pass", f"{len(overlap)} SKUs reconcile", metrics), None


def _check_volume_continuity(tx: pd.DataFrame, config: Config) -> HealthCheck:
    t = tx[tx["qty"] > 0].copy()
    t["week"] = _week_start(t["date"])
    weekly = t.groupby("week")["qty"].sum().sort_index()
    threshold = config.data_quality.volume_change_alert_pct / 100.0
    jumps: list[str] = []
    prev = weekly.shift(1)
    with np.errstate(divide="ignore", invalid="ignore"):
        change = (weekly - prev) / prev
    for week, chg in change.items():
        if pd.notna(chg) and prev[week] > 0 and abs(chg) >= threshold:
            jumps.append(f"{week.date()}: {chg:+.0%}")
    metrics = {"n_weeks": len(weekly), "n_jumps": len(jumps), "jumps": jumps[:10]}
    if jumps:
        return HealthCheck(
            "volume_continuity", "flag",
            f"{len(jumps)} week-on-week volume jumps beyond "
            f"+/-{config.data_quality.volume_change_alert_pct:.0f}% - investigate feed breaks",
            metrics,
        )
    return HealthCheck("volume_continuity", "pass", "no volume discontinuities", metrics)


def _check_intermittency(stats: pd.DataFrame, config: Config) -> HealthCheck:
    adi = stats["span_weeks"] / stats["present_weeks"].clip(lower=1)
    share = 100.0 * (adi >= config.segments.intermittent_adi).mean() if len(adi) else 0.0
    metrics = {
        "pct_intermittent": round(share, 1),
        "adi_threshold": config.segments.intermittent_adi,
        "median_adi": round(float(adi.median()), 2) if len(adi) else None,
    }
    if 50.0 <= share <= 80.0:
        return HealthCheck(
            "intermittency_profile", "pass",
            f"{share:.0f}% of catalogue intermittent (ADI >= "
            f"{config.segments.intermittent_adi}) - within expected 50-80%", metrics,
        )
    return HealthCheck(
        "intermittency_profile", "flag",
        f"{share:.0f}% of catalogue intermittent - outside the expected 50-80% band",
        metrics,
    )


def _check_sku_churn(tx: pd.DataFrame, stats: pd.DataFrame, config: Config) -> HealthCheck:
    data_end = stats["last_week"].max()
    dormancy = pd.Timedelta(weeks=config.segments.dormancy_weeks)
    quarters = pd.PeriodIndex(stats["first_week"], freq="Q")
    launches = pd.Series(1, index=quarters).groupby(level=0).sum()
    first_q = launches.index.min() if len(launches) else None
    launches_after_start = launches[launches.index != first_q] if first_q is not None else launches
    discontinued = stats[stats["last_week"] <= (data_end - dormancy)]
    disc_by_q = pd.Series(1, index=pd.PeriodIndex(discontinued["last_week"], freq="Q")).groupby(level=0).sum()
    n_skus = max(len(stats), 1)
    avg_launch = float(launches_after_start.mean()) if len(launches_after_start) else 0.0
    avg_disc = float(disc_by_q.mean()) if len(disc_by_q) else 0.0
    churn_rate = (avg_launch + avg_disc) / n_skus
    metrics = {
        "avg_launches_per_quarter": round(avg_launch, 1),
        "avg_discontinuations_per_quarter": round(avg_disc, 1),
        "quarterly_churn_pct_of_catalogue": round(100.0 * churn_rate, 1),
    }
    if churn_rate > 0.20:
        return HealthCheck(
            "sku_churn", "flag",
            f"high churn: ~{100 * churn_rate:.0f}% of catalogue turns over per quarter "
            "- cold-start weighting will matter", metrics,
        )
    return HealthCheck("sku_churn", "pass",
                       f"~{100 * churn_rate:.0f}% quarterly churn", metrics)


def _check_history_truncation(stats: pd.DataFrame) -> HealthCheck:
    data_start = stats["first_week"].min()
    data_end = stats["last_week"].max()
    window_weeks = ((data_end - data_start).days // 7) + 1
    if window_weeks < _TRUNCATION_MIN_SPAN_WEEKS:
        return HealthCheck(
            "history_truncation", "pass",
            f"data window ({window_weeks}w) too short to assess truncation",
            {"window_weeks": window_weeks},
        )
    cutoff = data_end - pd.Timedelta(weeks=_TRUNCATION_RECENT_WEEKS)
    recent = stats[stats["first_week"] > cutoff]
    share = 100.0 * len(recent) / max(len(stats), 1)
    metrics = {
        "n_recent_first_sale": len(recent),
        "pct_recent_first_sale": round(share, 1),
        "recent_weeks_window": _TRUNCATION_RECENT_WEEKS,
        "examples": list(recent.index[:10]),
    }
    if share > 10.0:
        return HealthCheck(
            "history_truncation", "flag",
            f"{share:.0f}% of SKUs first appear in the last "
            f"{_TRUNCATION_RECENT_WEEKS} weeks - possible renames or truncated export",
            metrics,
        )
    return HealthCheck("history_truncation", "pass",
                       f"{len(recent)} SKUs with suspiciously recent first sale", metrics)


def _check_return_lag(tx: pd.DataFrame) -> HealthCheck:
    returns = tx[tx["qty"] < 0][["sku", "date"]].sort_values("date")
    if returns.empty:
        return HealthCheck("return_lag", "pass", "no returns detected", {"n_returns": 0})
    sales = (
        tx[tx["qty"] > 0][["sku", "date"]]
        .rename(columns={"date": "sale_date"})
        .sort_values("sale_date")
    )
    merged = pd.merge_asof(
        returns, sales, left_on="date", right_on="sale_date", by="sku", direction="backward"
    )
    lags = (merged["date"] - merged["sale_date"]).dt.days.dropna()
    metrics = {
        "n_returns": int(len(returns)),
        "n_matched": int(len(lags)),
        "median_lag_days": float(lags.median()) if len(lags) else None,
        "p90_lag_days": float(lags.quantile(0.9)) if len(lags) else None,
        "max_lag_days": float(lags.max()) if len(lags) else None,
    }
    if len(lags) == 0:
        return HealthCheck("return_lag", "flag",
                           "returns present but none match a prior sale of the same SKU", metrics)
    return HealthCheck(
        "return_lag", "pass",
        f"{len(returns)} returns; median lag {metrics['median_lag_days']:.0f}d, "
        f"p90 {metrics['p90_lag_days']:.0f}d - sets the netting window", metrics,
    )


def _check_line_qty(tx: pd.DataFrame, config: Config) -> HealthCheck:
    qty = tx.loc[tx["qty"] > 0, "qty"]
    if qty.empty:
        return HealthCheck("line_qty_distribution", "flag", "no positive-quantity lines", {})
    med = float(qty.median())
    metrics = {
        "p50": med,
        "p90": float(qty.quantile(0.90)),
        "p99": float(qty.quantile(0.99)),
        "max": float(qty.max()),
        "bulk_threshold_units": med * config.demand.bulk_order_threshold_multiple,
    }
    return HealthCheck(
        "line_qty_distribution", "pass",
        f"median line qty {med:g}, p99 {metrics['p99']:g}; bulk threshold "
        f"{metrics['bulk_threshold_units']:g} units "
        f"({config.demand.bulk_order_threshold_multiple}x median)", metrics,
    )


def _check_price_availability(tx: pd.DataFrame) -> HealthCheck:
    usable = tx["unit_price"].notna() & (tx["unit_price"] > 0)
    pct = 100.0 * usable.mean() if len(tx) else 0.0
    metrics = {"pct_lines_with_price": round(pct, 1), "n_lines": len(tx)}
    if pct < _PRICE_AVAILABILITY_MIN_PCT:
        return HealthCheck(
            "price_availability", "flag",
            f"only {pct:.0f}% of lines carry a usable price (<"
            f"{_PRICE_AVAILABILITY_MIN_PCT:.0f}%) - revenue-based money figures unavailable",
            metrics,
        )
    return HealthCheck("price_availability", "pass",
                       f"{pct:.0f}% of lines have usable prices", metrics)


def _check_duplicates(tx: pd.DataFrame) -> HealthCheck:
    exact_cols = [c for c in ("date", "sku", "location", "qty", "unit_price", "order_id")
                  if c in tx.columns]
    near_cols = [c for c in ("date", "sku", "location", "qty") if c in tx.columns]
    exact = int(tx.duplicated(subset=exact_cols).sum())
    near_total = int(tx.duplicated(subset=near_cols).sum())
    near = max(near_total - exact, 0)
    metrics = {"exact_duplicates": exact, "near_duplicates": near,
               "exact_key": exact_cols, "near_key": near_cols}
    if exact or near:
        return HealthCheck(
            "duplicate_lines", "flag",
            f"{exact} exact and {near} near-duplicate lines - will be deduped and logged",
            metrics,
        )
    return HealthCheck("duplicate_lines", "pass", "no duplicate lines", metrics)


def _check_negative_stock(stock: pd.DataFrame | None) -> HealthCheck:
    if stock is None or len(stock) == 0:
        return HealthCheck("negative_stock", "pass", "no stock file supplied", {})
    if "_negative_stock_clamped" in stock.columns:
        n_neg = int(stock["_negative_stock_clamped"].sum())
    else:
        n_neg = int((stock["qty_on_hand"] < 0).sum())
    metrics = {"n_negative": n_neg, "n_rows": len(stock)}
    if n_neg:
        return HealthCheck(
            "negative_stock", "flag",
            f"{n_neg} stock lines had negative on-hand - treated as zero and flagged",
            metrics,
        )
    return HealthCheck("negative_stock", "pass", "no negative on-hand quantities", metrics)


def _no_price_no_cost_halt(tx: pd.DataFrame, stock: pd.DataFrame | None) -> str | None:
    has_price = bool((tx["unit_price"].notna() & (tx["unit_price"] > 0)).any())
    has_cost = (
        stock is not None
        and "unit_cost" in stock.columns
        and bool((stock["unit_cost"].notna() & (stock["unit_cost"] > 0)).any())
    )
    if not has_price and not has_cost:
        return "no usable price data and no cost data - nothing can be monetised"
    return None


# --- entry points -----------------------------------------------------------


def run_health(tx: pd.DataFrame, stock: pd.DataFrame | None, config: Config) -> HealthReport:
    """Run every Phase-0 check (SPEC §3) and return the go/no-go HealthReport.

    Halt (verdict 'no_go') only on the four SPEC conditions: median history
    below ``data_quality.min_median_history_weeks``; no price AND no cost;
    ambiguous zero-vs-null share above ``max_null_zero_ambiguity_pct``; sales
    and catalogue completely unreconcilable. Everything else is a flag.
    """
    if len(tx) == 0:
        return HealthReport(
            verdict="no_go",
            checks=[HealthCheck("history_depth", "fail", "sales file contains no rows", {})],
            halt_reasons=["sales file contains no usable rows"],
        )

    stats = _sku_week_stats(tx)
    checks: list[HealthCheck] = []
    halt_reasons: list[str] = []

    chk, halt = _check_history_depth(stats, config)
    checks.append(chk)
    if halt:
        halt_reasons.append(halt)

    chk, halt = _check_zero_vs_null(tx, stats, config)
    checks.append(chk)
    if halt:
        halt_reasons.append(halt)

    chk, halt = _check_catalogue_coverage(tx, stock)
    checks.append(chk)
    if halt:
        halt_reasons.append(halt)

    checks.append(_check_volume_continuity(tx, config))
    checks.append(_check_intermittency(stats, config))
    checks.append(_check_sku_churn(tx, stats, config))
    checks.append(_check_history_truncation(stats))
    checks.append(_check_return_lag(tx))
    checks.append(_check_line_qty(tx, config))

    price_chk = _check_price_availability(tx)
    money_halt = _no_price_no_cost_halt(tx, stock)
    if money_halt:
        price_chk = HealthCheck("price_availability", "fail", money_halt, price_chk.metrics)
        halt_reasons.append(money_halt)
    checks.append(price_chk)

    checks.append(_check_duplicates(tx))
    checks.append(_check_negative_stock(stock))

    return HealthReport(
        verdict="no_go" if halt_reasons else "go",
        checks=checks,
        halt_reasons=halt_reasons,
    )


_STATUS_ICON = {"pass": "OK", "flag": "FLAG", "fail": "FAIL"}


def render_health_text(report: HealthReport) -> str:
    """Human-readable markdown summary of the Phase-0 health audit."""
    lines: list[str] = []
    verdict = "GO" if report.verdict == "go" else "NO-GO"
    lines.append("# Phase 0 - Data health audit")
    lines.append("")
    lines.append(f"**Verdict: {verdict}**")
    lines.append("")
    if report.halt_reasons:
        lines.append("## Halt reasons")
        lines.append("")
        for reason in report.halt_reasons:
            lines.append(f"- {reason}")
        lines.append("")
        lines.append(
            "_None of these is a failed engagement: each is a finding, and the "
            "deliverable becomes a data remediation plan._"
        )
        lines.append("")
    lines.append("## Checks")
    lines.append("")
    lines.append("| Check | Status | Detail |")
    lines.append("|---|---|---|")
    for c in report.checks:
        detail = c.detail.replace("|", "\\|")
        lines.append(f"| {c.name} | {_STATUS_ICON.get(c.status, c.status)} | {detail} |")
    lines.append("")
    n_flag = sum(1 for c in report.checks if c.status == "flag")
    n_fail = sum(1 for c in report.checks if c.status == "fail")
    lines.append(f"{len(report.checks)} checks: {n_fail} failed, {n_flag} flagged.")
    return "\n".join(lines)
