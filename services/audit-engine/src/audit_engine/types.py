"""Small shared value types used across modules."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class LogRow:
    """One audit-log entry. Steps return these; the pipeline owns the writer,
    so no step can mutate the panel without leaving a trace."""

    step_number: int
    rule_name: str
    reason: str
    sku: str = ""
    location: str = ""
    week: str = ""          # ISO date of week_start, or '' for file-level rules
    value_before: str = ""
    value_after: str = ""
    confidence: str = ""


@dataclass
class HealthCheck:
    """One Phase 0 check result."""

    name: str
    status: str             # 'pass' | 'flag' | 'fail'
    detail: str
    metrics: dict[str, Any] = field(default_factory=dict)


@dataclass
class HealthReport:
    """Phase 0 output: go/no-go plus the first section of the client report."""

    verdict: str            # 'go' | 'no_go'
    checks: list[HealthCheck]
    halt_reasons: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "verdict": self.verdict,
            "halt_reasons": self.halt_reasons,
            "checks": [
                {"name": c.name, "status": c.status, "detail": c.detail, "metrics": c.metrics}
                for c in self.checks
            ],
        }
