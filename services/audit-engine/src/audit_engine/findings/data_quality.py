"""Finding 7.8 — data quality: Phase-0 health checks plus preprocessing
audit-log activity, summarised for the report."""
from __future__ import annotations

import pandas as pd

from audit_engine.config import Config

_DROP_HINTS = ("drop", "exclude", "dedup")


def data_quality_findings(health: dict, audit_log: pd.DataFrame | None,
                          config: Config) -> dict:
    """`health` is HealthReport.to_dict(); `audit_log` is AuditLogSchema-shaped.

    Returns a findings dict: verdict/halt reasons, checks grouped by status,
    and processing counts (rows dropped per rule, cells winsorized, promo
    weeks detected, bulk orders excluded) matched by rule-name substrings.
    """
    health = health or {}
    checks = [dict(c) for c in health.get("checks", [])]

    def _by_status(status: str) -> list[dict]:
        return [c for c in checks if c.get("status") == status]

    if audit_log is None or len(audit_log) == 0 or "rule_name" not in getattr(audit_log, "columns", []):
        rule_counts: dict[str, int] = {}
    else:
        rule_counts = {str(k): int(v) for k, v in audit_log["rule_name"].value_counts().items()}

    def _count(substring: str) -> int:
        return int(sum(n for r, n in rule_counts.items() if substring in r.lower()))

    rows_dropped = {
        r: n for r, n in rule_counts.items()
        if any(h in r.lower() for h in _DROP_HINTS)
    }
    processing = {
        "total_log_rows": int(sum(rule_counts.values())),
        "rule_counts": rule_counts,
        "rows_dropped": rows_dropped,
        "rows_dropped_total": int(sum(rows_dropped.values())),
        "cells_winsorized": _count("winsor"),
        "promo_weeks_detected": _count("promo"),
        "bulk_orders_excluded": _count("bulk"),
    }
    return {
        "verdict": health.get("verdict", "unknown"),
        "halt_reasons": list(health.get("halt_reasons", [])),
        "n_pass": len(_by_status("pass")),
        "n_flag": len(_by_status("flag")),
        "n_fail": len(_by_status("fail")),
        "checks": checks,
        "flagged": _by_status("flag"),
        "failed": _by_status("fail"),
        "processing": processing,
    }
