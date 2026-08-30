"""Typed configuration tree: YAML defaults deep-merged with client overrides.

The config hash (sha256 of the canonical JSON dump) is part of every run_id,
so any change to any threshold produces a distinguishable run.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, ConfigDict, field_validator


class _Section(BaseModel):
    model_config = ConfigDict(extra="allow")


class TimeCfg(_Section):
    bucket: str = "weekly"
    week_start: str = "monday"
    date_basis: str = "order_date"


class DemandCfg(_Section):
    bulk_order_threshold_multiple: float = 5
    returns_netted_to: str = "original_sale_date"
    returns_window_weeks: int = 8
    exclude_types: list[str] = ["staff", "test", "cancelled", "fraud"]


class AvailabilityCfg(_Section):
    source: str = "inferred"
    zero_run_pvalue: float = 0.01
    min_velocity_per_day: float = 1.0
    cross_sectional_closure_threshold: float = 0.60
    cross_sectional_ambiguous_threshold: float = 0.20
    correction_cap_multiple: float = 1.5
    min_instock_days_per_week: int = 3


class BaselineCfg(_Section):
    statistic: str = "median"
    window_weeks: int = 13
    min_usable_weeks: int = 6
    winsorize_multiple: float = 2.0
    level_shift_consecutive_weeks: int = 4
    trend: str = "none"

    @field_validator("winsorize_multiple")
    @classmethod
    def _cap_ge_one(cls, v: float) -> float:
        if v < 1:
            raise ValueError("winsorize_multiple must be >= 1")
        return v


class EventsCfg(_Section):
    detection: str = "price_based_retro"
    price_drop_threshold_pct: float = 15


class SeasonalityCfg(_Section):
    min_years_for_own: int = 2
    fallback: str = "cluster_pooled"
    min_cluster_size: int = 20
    index_bounds: list[float] = [0.4, 3.0]


class SegmentsCfg(_Section):
    abc_thresholds: list[float] = [0.80, 0.95]
    xyz_cv_thresholds: list[float] = [0.5, 1.0]
    intermittent_adi: float = 1.32
    intermittent_cv2: float = 0.49
    dormancy_weeks: int = 8


class ModelsCfg(_Section):
    roster: list[str] = ["M1", "M2", "M3", "M4_4", "M4_8", "M4_13", "M5", "M6", "M7", "M8", "M9", "M10"]
    stretch: list[str] = ["M11", "M12"]
    default_champion: str = "M5"
    intermittent_default: str = "M9"
    ses_alpha_bounds: list[float] = [0.05, 0.40]
    ets_min_weeks: int = 104
    seasonal_naive_min_weeks: int = 52
    # Optional per-run selection from the frontend/API. When non-empty these
    # override `roster` / `combinations.enabled` for the harness; validated
    # against models.catalog.valid_ids() at roster-build time (unknown ids
    # dropped and logged). Empty => use the defaults above.
    selected_models: list[str] = []
    selected_combos: list[str] = []


class CombinationsCfg(_Section):
    enabled: list[str] = ["C1", "C5", "C6"]
    members_c1: list[str] = ["M5", "M7", "M10"]
    residual_corr_max: float = 0.90
    inverse_error_weight_floor: float = 0.10
    exclude_intermittent: bool = True


class PerSkuOverrideCfg(_Section):
    min_origins: int = 12
    min_margin_pct: float = 5
    require_stability_windows: int = 2


class SelectionCfg(_Section):
    nested: bool = True
    selection_origins_target: int = 10
    selection_origins_minimum: int = 6
    validation_origins_target: int = 6
    validation_origins_minimum: int = 3
    step_weeks: int = 4
    horizon_weeks: int = 4
    training_window: str = "expanding"
    min_weeks_nested: int = 65
    min_weeks_inner_only: int = 49
    below_minimum: str = "default_to_M5"
    validation_block_touches: int = 1
    strategies: list[str] = ["S0", "S1", "S2"]
    primary_metric: str = "wape"
    floor_model: str = "M2"
    exclude_censored_score_weeks: bool = True
    max_excluded_pct: float = 25
    per_sku_override: PerSkuOverrideCfg = PerSkuOverrideCfg()
    status: str = "provisional"


class FindingsCfg(_Section):
    dead_stock_weeks: list[int] = [8, 13, 26]
    overstock_cover_weeks: list[int] = [12, 26]
    runout_cover_weeks: float = 2
    repeat_offender_episodes: int = 3
    money_figures_min_confidence: str = "medium"


class ReportingCfg(_Section):
    ranges_required: bool = True
    claim_absolute_accuracy: bool = False
    limitations_section: str = "mandatory"


class DataQualityCfg(_Section):
    max_null_zero_ambiguity_pct: float = 40
    volume_change_alert_pct: float = 60
    min_median_history_weeks: int = 13
    on_failure: str = "halt_and_report"


class Config(_Section):
    client: str = "default"
    time: TimeCfg = TimeCfg()
    demand: DemandCfg = DemandCfg()
    availability: AvailabilityCfg = AvailabilityCfg()
    baseline: BaselineCfg = BaselineCfg()
    events: EventsCfg = EventsCfg()
    seasonality: SeasonalityCfg = SeasonalityCfg()
    segments: SegmentsCfg = SegmentsCfg()
    models: ModelsCfg = ModelsCfg()
    combinations: CombinationsCfg = CombinationsCfg()
    selection: SelectionCfg = SelectionCfg()
    findings: FindingsCfg = FindingsCfg()
    reporting: ReportingCfg = ReportingCfg()
    data_quality: DataQualityCfg = DataQualityCfg()


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    out = dict(base)
    for key, val in override.items():
        if isinstance(val, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], val)
        else:
            out[key] = val
    return out


def load_config(defaults_path: str | Path, client_path: str | Path | None = None) -> Config:
    with open(defaults_path, encoding="utf-8") as f:
        merged = yaml.safe_load(f) or {}
    if client_path is not None:
        with open(client_path, encoding="utf-8") as f:
            merged = _deep_merge(merged, yaml.safe_load(f) or {})
    return Config.model_validate(merged)


def config_hash(cfg: Config) -> str:
    canonical = json.dumps(cfg.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
