"""The 20 combination specs (CC01..CC20) and their roster builder.

Each spec is ``{"kind", "members", "weights"?}`` and is materialized into a
fresh combo via :func:`audit_engine.models.combos.build_combo`, which pulls
each member id through the model registry. Combos reference members BY ID; if a
member id is not buildable yet (another agent may not have landed M13-M22), the
spec is SKIPPED and recorded rather than crashing the whole roster.

Every built combo carries a ``.member_ids`` attribute so the orchestrator can
apply the SPEC 9 residual-correlation diversity gate at scoring time (the gate
needs backtest residuals, which do not exist at construction time) and drop /
report gate-failing combos.

The specs are designed for DIVERSITY — members that make *different* errors —
spanning the C1-C7 families:
  - median-of-3 and mean-of-3 blends of a robust baseline (M5) with reactive
    (M6/M7), state-space (M9/M10-like), trend (M18) and structural (M16/M20/M22)
    members;
  - trimmed-mean-of-5 sets that survive one outlying member per tail;
  - inverse-error-weighted pairs/triples;
  - two-layer baseline+uplift combos;
  - intermittent-specialist blends built around Croston/TSB/ADIDA (M8/M9/M13-M16).
"""
from __future__ import annotations

import logging

from .base import BatchModel
from .combos import build_combo

logger = logging.getLogger(__name__)


# id -> {"kind", "members", ["weights"]}. Exactly 20 entries.
COMBO_SPECS: dict[str, dict] = {
    # --- median-of-3 --------------------------------------------------------
    "CC01": {"kind": "median", "members": ["M5", "M7", "M10"]},
    "CC02": {"kind": "median", "members": ["M5", "M9", "M18"]},
    "CC03": {"kind": "median", "members": ["M5", "M6", "M16"]},
    "CC04": {"kind": "median", "members": ["M5", "M18", "M21"]},
    # --- mean-of-3 ----------------------------------------------------------
    "CC05": {"kind": "mean", "members": ["M5", "M7", "M9"]},
    "CC06": {"kind": "mean", "members": ["M6", "M18", "M20"]},
    "CC07": {"kind": "mean", "members": ["M5", "M16", "M22"]},
    # --- trimmed-mean-of-5 --------------------------------------------------
    "CC08": {"kind": "trimmed", "members": ["M5", "M6", "M7", "M9", "M18"]},
    "CC09": {"kind": "trimmed", "members": ["M4_8", "M5", "M6", "M20", "M21"]},
    "CC10": {"kind": "trimmed", "members": ["M5", "M9", "M16", "M18", "M22"]},
    # --- inverse-error-weighted --------------------------------------------
    "CC11": {"kind": "inverse_error", "members": ["M5", "M7"], "weights": [1.0, 1.0]},
    "CC12": {"kind": "inverse_error", "members": ["M5", "M9"], "weights": [1.0, 1.0]},
    "CC13": {"kind": "inverse_error", "members": ["M5", "M6", "M9"], "weights": [1.0, 1.0, 1.0]},
    "CC14": {"kind": "inverse_error", "members": ["M6", "M18", "M20"], "weights": [1.0, 1.0, 1.0]},
    # --- two-layer (base + uplift) -----------------------------------------
    "CC15": {"kind": "two_layer", "members": ["M5", "M7"]},   # M5 base + M7 uplift
    "CC16": {"kind": "two_layer", "members": ["M5", "M18"]},  # M5 base + M18 uplift
    "CC17": {"kind": "two_layer", "members": ["M9", "M16"]},  # M9 base + M16 uplift
    # --- intermittent specialists ------------------------------------------
    "CC18": {"kind": "median", "members": ["M8", "M9", "M13"]},
    "CC19": {"kind": "median", "members": ["M9", "M15", "M16"]},
    "CC20": {"kind": "mean", "members": ["M9", "M14", "M22"]},
}

assert len(COMBO_SPECS) == 20, f"expected 20 combo specs, got {len(COMBO_SPECS)}"


def _spec_kwargs(spec: dict) -> dict:
    """Extra kwargs for build_combo, derived from a spec (weights, etc.)."""
    kwargs: dict = {}
    if "weights" in spec:
        kwargs["weights"] = spec["weights"]
    if "w" in spec:
        kwargs["w"] = spec["w"]
    return kwargs


def build_combo_roster(config) -> dict[str, BatchModel]:
    """Construct all 20 combos as fresh instances, each carrying ``.member_ids``.

    A combo whose member ids are not all buildable (KeyError from the registry)
    is skipped, not fatal — the skipped ids are logged and attached to the
    returned dict as a ``.skipped`` attribute: ``list[tuple[combo_id, reason]]``.
    Callers that only want the models can ignore the attribute; the orchestrator
    can read it to report which combos were dropped for missing members.
    """
    roster: dict[str, BatchModel] = {}
    skipped: list[tuple[str, str]] = []

    for combo_id, spec in COMBO_SPECS.items():
        kind = spec["kind"]
        members = spec["members"]
        try:
            roster[combo_id] = build_combo(
                combo_id, members, config, kind, **_spec_kwargs(spec)
            )
        except Exception as exc:  # missing member id or bad kind -> skip, record
            reason = f"{type(exc).__name__}: {exc}"
            skipped.append((combo_id, reason))
            logger.warning(
                "combo %s skipped (members=%s): %s", combo_id, members, reason
            )

    # attach skip report without disturbing the dict's model-id -> model mapping
    roster_obj: dict[str, BatchModel] = _RosterDict(roster)
    roster_obj.skipped = skipped
    return roster_obj


class _RosterDict(dict):
    """A plain dict that also carries a ``.skipped`` attribute."""

    skipped: list[tuple[str, str]] = []
