"""Model registry: config -> fresh BatchModel instances, keyed by model_id.

All thresholds come from the Config tree — nothing numeric is hard-coded
here beyond the intermittent smoothing constants that SPEC fixes at 0.1.
"""
from __future__ import annotations

from ..config import Config
from .base import BatchModel
from .broad import DampedHolt, Holt, RecencyPoissonRate, TrimmedMean, WeightedMA
from .ets import ETSDampedMult
from .intermittent import TSB, CrostonSBA
from .intermittent_ext import (
    ADIDA,
    CrostonOriginal,
    CrostonSBAOpt,
    TSBOpt,
    ZeroForecast,
)
from .median import MedianWinsorized
from .naive import MovingAverage, NaiveDrift, NaiveLast, NaiveSeasonal
from .smoothing import SES, Theta


def _build(model_id: str, config: Config) -> BatchModel:
    m = config.models
    if model_id == "M1":
        return NaiveLast()
    if model_id == "M2":
        return NaiveSeasonal(min_history_weeks=m.seasonal_naive_min_weeks)
    if model_id == "M3":
        return NaiveDrift()
    if model_id.startswith("M4_"):
        try:
            n = int(model_id.split("_", 1)[1])
        except ValueError:
            raise KeyError(f"unknown model id: {model_id!r}") from None
        return MovingAverage(n)
    if model_id == "M5":
        return MedianWinsorized(
            window=config.baseline.window_weeks,
            cap_multiple=config.baseline.winsorize_multiple,
        )
    if model_id == "M6":
        return SES(alpha_bounds=tuple(m.ses_alpha_bounds))
    if model_id == "M7":
        return Theta(alpha_bounds=tuple(m.ses_alpha_bounds))
    if model_id == "M8":
        return CrostonSBA()
    if model_id == "M9":
        return TSB()
    if model_id == "M10":
        return ETSDampedMult(min_history_weeks=m.ets_min_weeks)
    # M13-M17: intermittent-family extensions (intermittent_ext.py).
    if model_id == "M13":
        return CrostonOriginal()
    if model_id == "M14":
        return CrostonSBAOpt(alpha_bounds=tuple(m.ses_alpha_bounds))
    if model_id == "M15":
        return TSBOpt()
    if model_id == "M16":
        return ADIDA(alpha_bounds=tuple(m.ses_alpha_bounds))
    if model_id == "M17":
        return ZeroForecast()
    # M18-M22: broad-statistical family (broad.py).
    if model_id == "M18":
        return Holt()
    if model_id == "M19":
        return DampedHolt()
    if model_id == "M20":
        return WeightedMA()
    if model_id == "M21":
        return TrimmedMean()
    if model_id == "M22":
        return RecencyPoissonRate()
    raise KeyError(f"unknown model id: {model_id!r}")


def build_roster(config: Config) -> dict[str, BatchModel]:
    """Fresh instances for every id in config.models.roster.

    Unknown ids raise KeyError. Every call returns brand-new instances —
    the harness refits per origin and must never share state across runs.
    """
    return {model_id: _build(model_id, config) for model_id in config.models.roster}
