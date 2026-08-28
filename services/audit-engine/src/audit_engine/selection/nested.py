"""Nested selection experiment: inner loop picks, outer loop audits the pick.

The validation block is scored ONCE per run directory. A marker file
('outer_touched.marker') enforces it: a second attempt raises unless
force=True, and every touch is timestamped in validation_log.txt. The gap
between selection-block and validation-block error is the winner's curse,
quantified (SPEC §10).
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import numpy as np
import pandas as pd
import yaml

from ..models.base import BatchModel
from ..panel import PanelMatrices
from .harness import empty_scores, plan_origins, run_backtest
from .routing import (
    pick_champions, routing_table, selection_gap, strategy_scores, winner_stability,
)

__all__ = ["run_nested"]

MARKER_NAME = "outer_touched.marker"


def _usable_weeks(mats: PanelMatrices) -> int:
    """Effective panel length: weeks up to the last week usable for any series.

    Trailing all-unusable weeks would silently eat the validation block, so
    origins are anchored to the last usable week instead of the raw panel end.
    """
    any_usable = mats.usable_mask.any(axis=0)
    if not any_usable.any():
        return 0
    return int(np.nonzero(any_usable)[0][-1] + 1)


def _fmt(x) -> str:
    if x is None or (isinstance(x, float) and not np.isfinite(x)):
        return "n/a"
    return f"{x:.4f}" if isinstance(x, float) else str(x)


def _analysis_md(tier: str, plan: dict, excluded_pct: float, gap: pd.DataFrame,
                 stability: pd.DataFrame, routing: dict, config) -> str:
    lines = [
        "# Selection analysis",
        "",
        f"- Tier: **{tier}**",
        f"- Usable weeks: {plan.get('n_weeks_usable')} "
        f"(needed {plan.get('weeks_needed')}; step {plan.get('step_weeks')}w, "
        f"horizon {plan.get('horizon_weeks')}w)",
        f"- Selection origins: {plan.get('selection_origins')}; "
        f"validation origins: {plan.get('validation_origins')}",
        f"- Censored score weeks excluded: {excluded_pct:.1f}% "
        f"(threshold {config.selection.max_excluded_pct}%"
        + (" — EXCEEDED, selection result too thin)" if excluded_pct > config.selection.max_excluded_pct else ")"),
        f"- Status: {routing.get('status')}"
        + ("" if routing.get("validated") else " (champion UNVALIDATED — no outer block)"),
        "",
        "## Strategy comparison (selection vs validation WAPE)",
        "",
        "| strategy | sel WAPE | val WAPE | gap |",
        "|---|---|---|---|",
    ]
    for _, r in gap.iterrows():
        lines.append(
            f"| {r['strategy']} | {_fmt(float(r['sel_wape']))} | "
            f"{_fmt(float(r['val_wape']))} | {_fmt(float(r['gap']))} |"
        )
    lines += ["", "## Winner stability", ""]
    if len(stability):
        mean_flip = float(stability["flip_rate"].mean())
        lines.append(f"- Mean per-SKU champion flip rate: {mean_flip:.2f} "
                     + ("(>0.40 — selection is fitting noise)" if mean_flip > 0.40 else ""))
    else:
        lines.append("- No stability data (no scored selection rows).")
    lines += ["", "## Routing table", "",
              "| segment | champion | fallback | val WAPE |", "|---|---|---|---|"]
    for seg, row in routing.get("segments", {}).items():
        lines.append(f"| {seg} | {row['champion']} | {row['fallback']} | {_fmt(row['val_wape'])} |")
    if not routing.get("segments"):
        lines.append(f"| (all) | {routing.get('default_champion')} | "
                     f"{routing.get('floor_model')} | n/a |")
    lines += ["", "_Selection on censored history is provisional; no absolute "
                  "accuracy is claimed — comparisons are relative to the naive floor._", ""]
    return "\n".join(lines)


def run_nested(
    mats: PanelMatrices,
    roster_factory: Callable[[], dict[str, BatchModel]],
    config,
    segments: pd.DataFrame | None,
    run_dir: Path | str,
    force: bool = False,
) -> dict:
    """Full nested selection experiment; persists artifacts to run_dir.

    Artifacts: model_scores.parquet, selection_gap.parquet,
    winner_stability.parquet, routing_table.yaml, selection_analysis.md,
    outer_touched.marker + validation_log.txt (touch-once enforcement).

    Returns dict: tier, plan, sel_scores, val_scores, champions, routing,
    selection_gap, winner_stability, strategy_comparison, excluded_pct.
    """
    run_dir = Path(run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)
    scfg = config.selection

    n_usable = _usable_weeks(mats)
    plan = plan_origins(n_usable, scfg)
    tier = plan["tier"]

    if tier == "none":
        routing = {
            "status": str(scfg.status),
            "validated": False,
            "default_champion": str(config.models.default_champion),
            "floor_model": str(scfg.floor_model),
            "segments": {},
            "reason": (
                f"history too short for selection: {n_usable} usable weeks < "
                f"{scfg.min_weeks_inner_only} minimum — defaulting to "
                f"{config.models.default_champion}"
            ),
        }
        with open(run_dir / "routing_table.yaml", "w", encoding="utf-8") as f:
            yaml.safe_dump(routing, f, sort_keys=False)
        (run_dir / "selection_analysis.md").write_text(
            "# Selection analysis\n\n- Tier: **none** — history too short; "
            f"defaulting to {config.models.default_champion}.\n",
            encoding="utf-8",
        )
        return {
            "tier": "none", "plan": plan, "routing": routing,
            "sel_scores": empty_scores(), "val_scores": empty_scores(),
            "champions": pd.DataFrame(
                [{"strategy": "S0", "scope": "global", "scope_value": "ALL",
                  "champion_model_id": config.models.default_champion}]
            ),
            "selection_gap": pd.DataFrame(columns=["strategy", "sel_wape", "val_wape", "gap"]),
            "winner_stability": pd.DataFrame(columns=["sku", "location", "n_origins", "flip_rate"]),
            "strategy_comparison": pd.DataFrame(columns=["strategy", "sel_wape", "val_wape", "gap"]),
            "excluded_pct": 0.0,
        }

    # ---- inner loop: selection block --------------------------------------
    sel_bt = run_backtest(mats, roster_factory, config, segments,
                          blocks=("selection",), origin_plan=plan)
    intermittent_ok = {
        mid for mid, m in roster_factory().items()
        if getattr(m, "handles_intermittent", False)
    } or None
    champions = pick_champions(sel_bt.scores, segments, config,
                               intermittent_ok=intermittent_ok)
    stability = winner_stability(sel_bt.scores)

    # ---- outer loop: validation block, touched once -----------------------
    val_scores = empty_scores()
    if tier == "nested" and plan["validation_origin_idx"]:
        marker = run_dir / MARKER_NAME
        if marker.exists() and not force:
            raise RuntimeError(
                f"Validation block for {run_dir} was already scored "
                f"({marker} exists). The outer block may be touched exactly "
                "once per run — re-scoring it invalidates the selection-gap "
                "guarantee. Pass force=True only if you accept that."
            )
        stamp = datetime.now(timezone.utc).isoformat()
        marker.write_text(stamp + "\n", encoding="utf-8")
        with open(run_dir / "validation_log.txt", "a", encoding="utf-8") as f:
            f.write(
                f"{stamp} validation block scored; "
                f"origins={plan['validation_origin_idx']} force={force}\n"
            )
        champ_ids = set(champions["champion_model_id"].astype(str))

        def champion_roster() -> dict[str, BatchModel]:
            return {mid: m for mid, m in roster_factory().items() if mid in champ_ids}

        val_bt = run_backtest(mats, champion_roster, config, segments,
                              blocks=("validation",), origin_plan=plan)
        val_scores = val_bt.scores

    # ---- diagnostics: strategy comparison + gap ---------------------------
    sel_strat = strategy_scores(sel_bt.scores, champions, segments)
    val_strat = strategy_scores(val_scores, champions, segments)
    gap = selection_gap(sel_strat, val_strat)

    routing = routing_table(champions, val_scores, config)
    if tier == "inner_only":
        routing["status"] = f"{scfg.status}_unvalidated"

    # ---- persist artifacts -------------------------------------------------
    all_scores = (
        pd.concat([sel_bt.scores, val_scores], ignore_index=True)
        if len(val_scores) else sel_bt.scores
    )
    all_scores.to_parquet(run_dir / "model_scores.parquet", index=False)
    gap.to_parquet(run_dir / "selection_gap.parquet", index=False)
    stability.to_parquet(run_dir / "winner_stability.parquet", index=False)
    with open(run_dir / "routing_table.yaml", "w", encoding="utf-8") as f:
        yaml.safe_dump(routing, f, sort_keys=False)
    (run_dir / "selection_analysis.md").write_text(
        _analysis_md(tier, plan, sel_bt.excluded_pct, gap, stability, routing, config),
        encoding="utf-8",
    )

    return {
        "tier": tier,
        "plan": plan,
        "sel_scores": sel_bt.scores,
        "val_scores": val_scores,
        "champions": champions,
        "routing": routing,
        "selection_gap": gap,
        "winner_stability": stability,
        "strategy_comparison": gap,
        "excluded_pct": sel_bt.excluded_pct,
    }
