"""Typed decision-policy tree loaded from config/policy.yaml.

The policy is the engine's standing rulebook: every threshold the decision
engine uses comes from here, nothing is hard-coded. Fields carry the YAML
values as defaults so a missing file still yields a working policy.

`policy_hash()` mirrors `config_hash()` — the sha256 of the canonical JSON
dump — so any tuned threshold produces a distinguishable, auditable run.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, ConfigDict


class _Block(BaseModel):
    # extra=allow so unknown keys added to the YAML don't break loading, and
    # still round-trip into the hash.
    model_config = ConfigDict(extra="allow")


# --- 1. Data sufficiency ---------------------------------------------------
class DataSufficiencyAssume(_Block):
    thin_history: str = "cluster_analog"        # cluster_analog | no_forecast
    no_backtest: str = "rule_default_model"


class DataSufficiencyCfg(_Block):
    min_weeks_forecastable: int = 13
    min_weeks_backtest: int = 49
    min_weeks_validated: int = 65
    min_nonzero_weeks: int = 4
    assume: DataSufficiencyAssume = DataSufficiencyAssume()


# --- 2. Price & money ------------------------------------------------------
class PriceAssume(_Block):
    missing_price: str = "units_only"           # units_only | skip_money
    price_fill: str = "sku_median_then_global"


class PriceCfg(_Block):
    min_price_coverage_pct: float = 80
    assume: PriceAssume = PriceAssume()


# --- 3. Promotions ---------------------------------------------------------
class PromotionsAssume(_Block):
    no_calendar: str = "derive_from_price"      # derive_from_price | ignore_promos
    exclude_from_baseline: bool = True


class PromotionsCfg(_Block):
    detection: str = "price_based_retro"        # price_based_retro | calendar_only
    price_drop_threshold_pct: float = 15
    assume: PromotionsAssume = PromotionsAssume()


# --- 4. Classification -----------------------------------------------------
class ClassificationAssume(_Block):
    no_category: str = "correlation_cluster"    # correlation_cluster | no_pooling
    min_cluster_size: int = 20


class ClassificationCfg(_Block):
    abc_thresholds: list[float] = [0.80, 0.95]
    xyz_cv_thresholds: list[float] = [0.5, 1.0]
    intermittent_adi: float = 1.32
    intermittent_cv2: float = 0.49
    dormancy_weeks: int = 8
    new_weeks: int = 8
    launch_min_weeks: int = 4
    assume: ClassificationAssume = ClassificationAssume()


# --- 5. Action routing -----------------------------------------------------
class ActionsCfg(_Block):
    dormant: str = "run_down"
    new: str = "launch_watch"
    intermittent_high: str = "buffer_rule"
    intermittent_other: str = "pool_rule"
    a_steady: str = "forecast_review"
    a_variable: str = "forecast_buffer"
    b_steady: str = "forecast_auto"
    default: str = "pool_rule"


# --- 6. Model auto-pick ----------------------------------------------------
class SegmentDefaultsCfg(_Block):
    intermittent: str = "M9"
    intermittent_alt: str = "M8"
    seasonal_2yr: str = "M10"
    smooth_a: str = "M7"
    smooth_b: str = "M5"
    erratic: str = "M5"
    new: str = "cluster_analog"
    dormant: str = "none"
    global_default: str = "M5"


class OverrideCfg(_Block):
    min_relative_wape_gain: float = 0.10
    max_bias_abs_pct: float = 20
    require_beats_naive_floor: bool = True
    require_validated: bool = True


class AutopickCfg(_Block):
    segment_defaults: SegmentDefaultsCfg = SegmentDefaultsCfg()
    intermittent_default: str = "M9"
    override: OverrideCfg = OverrideCfg()
    combo_residual_corr_max: float = 0.90
    exclude_intermittent_from_combos: bool = True


# --- 7. Confidence ---------------------------------------------------------
class ConfidenceCfg(_Block):
    max_censored_pct_for_high: float = 25
    status: str = "provisional"


class Policy(_Block):
    version: int = 1
    data_sufficiency: DataSufficiencyCfg = DataSufficiencyCfg()
    price: PriceCfg = PriceCfg()
    promotions: PromotionsCfg = PromotionsCfg()
    classification: ClassificationCfg = ClassificationCfg()
    actions: ActionsCfg = ActionsCfg()
    autopick: AutopickCfg = AutopickCfg()
    confidence: ConfidenceCfg = ConfidenceCfg()


def load_policy(path: str | Path = "config/policy.yaml") -> Policy:
    """Load the decision policy. A missing file yields the defaults above (which
    mirror the shipped YAML), so the engine always has a rulebook to apply."""
    p = Path(path)
    if not p.exists():
        return Policy()
    with open(p, encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}
    return Policy.model_validate(raw)


def policy_hash(policy: Policy) -> str:
    """sha256 of the canonical JSON dump — stable across runs, changes when any
    threshold changes. Mirrors config.config_hash."""
    canonical = json.dumps(policy.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
