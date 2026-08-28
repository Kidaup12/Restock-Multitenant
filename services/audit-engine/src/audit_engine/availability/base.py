"""Pluggable availability interface — the one architectural decision that matters.

v1 implementation (inferred.py) infers in-stock days from zero-runs; v2 will
read real daily snapshots. Everything downstream (baseline, lost sales, cover)
consumes this interface and does not know which implementation produced it.
"""
from __future__ import annotations

from abc import ABC, abstractmethod

import pandas as pd


class AvailabilitySource(ABC):
    @abstractmethod
    def in_stock_days(self, daily: pd.DataFrame, config) -> tuple[pd.DataFrame, pd.DataFrame]:
        """Estimate availability from daily sales.

        Parameters
        ----------
        daily : DataFrame with columns (sku, location, date, units) on a complete
            daily calendar spine within each SKU's active lifespan (missing
            sale days present as zeros).
        config : audit_engine.config.Config

        Returns
        -------
        weekly : DataFrame (sku, location, week_start, in_stock_days [0-7],
            confidence) — one row per SKU-location-week.
        episodes : DataFrame matching schemas.StockoutSchema — one row per
            suspected stockout episode (sku, location, start_date, end_date,
            days, confidence, p_value, cross_sectional_share).
        """
