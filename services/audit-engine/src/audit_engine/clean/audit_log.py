"""Audit-log collector for the 17-step cleaning chain.

The pipeline owns a single AuditLog instance; steps return lists of LogRow and
never write directly, so no step can mutate the panel without leaving a trace.
"""
from __future__ import annotations

from dataclasses import asdict
from pathlib import Path

import pandas as pd

from audit_engine.schemas import AuditLogSchema
from audit_engine.types import LogRow

_COLUMNS = [
    "sku",
    "location",
    "week",
    "step_number",
    "rule_name",
    "value_before",
    "value_after",
    "reason",
    "confidence",
]


class AuditLog:
    """Collects LogRow entries; renders/validates them as AuditLogSchema."""

    def __init__(self) -> None:
        self._rows: list[LogRow] = []

    def extend(self, rows: list[LogRow]) -> None:
        self._rows.extend(rows)

    def __len__(self) -> int:
        return len(self._rows)

    def to_frame(self) -> pd.DataFrame:
        if not self._rows:
            df = pd.DataFrame(
                {
                    col: pd.Series(dtype="int64" if col == "step_number" else str)
                    for col in _COLUMNS
                }
            )
            return AuditLogSchema.validate(df)
        df = pd.DataFrame([asdict(r) for r in self._rows])[_COLUMNS]
        return AuditLogSchema.validate(df)

    def write(self, path: str | Path) -> None:
        self.to_frame().to_parquet(Path(path), index=False)
