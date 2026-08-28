"""Policy-driven decision engine: one defensible decision per SKU-location.

This SUPERSEDES the ad-hoc rules in findings/playbook.py by driving the same
kinds of actions from config/policy.yaml instead of hard-coded literals. Every
threshold comes from the Policy; every decision cites the rule that fired and
lists what it had to assume because the client's data was thin.

RULE PRECEDENCE (checked top to bottom; first match wins the action):

  1. DATA-SUFFICIENCY GATE — usable_weeks < policy.data_sufficiency
     .min_weeks_forecastable AND too few non-zero weeks -> NOT forecastable.
     Action from the thin_history assume default:
       cluster_analog -> pool_rule (borrow a cluster/category analog)
       no_forecast    -> no_action
  2. LIFECYCLE —
       dormant -> actions.dormant (run_down), model = segment_defaults.dormant
       new (within classification.new_weeks) -> actions.new (launch_watch),
         model = segment_defaults.new
  3. INTERMITTENCY — intermittent_flag OR xyz == 'Z' ->
       A-class -> actions.intermittent_high (buffer_rule)
       else    -> actions.intermittent_other (pool_rule)
     model = autopick.intermittent_default (never takes a combo).
  4. VALUE × STEADINESS — the actions mapping:
       A + steady(X)   -> a_steady   (forecast_review), model smooth_a
       A + variable(Y) -> a_variable (forecast_buffer), model smooth_a
       B + steady(X)   -> b_steady   (forecast_auto),   model smooth_b
       else            -> default    (pool_rule),        model global_default

MODEL AUTO-PICK — rules first, the backtest only breaks ties. Start from the
policy segment-default model for the SKU's routing segment. If backtest_routing
carries a champion for that segment, it REPLACES the rule default only when it
clears autopick.override (relative WAPE gain vs the rule default's val_wape,
|bias| within bounds if available, require_validated). Otherwise the rule
default is kept and the reason notes the challenger did not clear the margin.
Intermittent SKUs never take a combo (exclude_intermittent_from_combos).

CONFIDENCE — high only when the model came from a VALIDATED backtest override
(or a strong rule default: A-class steady/variable) AND history is at least
min_weeks_validated AND censoring is acceptable; medium for ordinary rule
defaults / inner-only; low for cluster-analog / thin history. Status is always
policy.confidence.status ('provisional').
"""
from __future__ import annotations

from dataclasses import dataclass, field

import pandas as pd

from .policy import Policy

_KEYS = ["sku", "location"]

# routing segment -> stance for the resulting action
_STANCE_BY_ACTION = {
    "forecast_review": "forecast",
    "forecast_buffer": "forecast",
    "forecast_auto": "forecast",
    "buffer_rule": "rule",
    "pool_rule": "rule",
    "run_down": "none",
    "no_action": "none",
    "launch_watch": "launch",
}


@dataclass
class DecisionResult:
    """Output of `decide`.

    per_sku: DataFrame with columns
        [sku, location, action, model, stance, confidence, reason, assumptions]
      where `assumptions` is the per-SKU list joined with '; '.
    summary: DataFrame by action with [action, n_skus, revenue_share].
    assumptions: dedup'd catalogue-level list of every distinct assumption.
    policy_version: the policy `version` int.
    """

    per_sku: pd.DataFrame
    summary: pd.DataFrame
    assumptions: list[str]
    policy_version: int
    per_sku_columns: tuple[str, ...] = field(
        default=("sku", "location", "action", "model", "stance",
                 "confidence", "reason", "assumptions")
    )


def _combo_ok(model: str, is_intermittent: bool, policy: Policy) -> bool:
    """A combo model (id starts with 'C') may not be taken by intermittent SKUs
    when exclude_intermittent_from_combos is set."""
    if not str(model).startswith("C"):
        return True
    if is_intermittent and policy.autopick.exclude_intermittent_from_combos:
        return False
    return True


def _segment_default_model(segment: str, abc: str, xyz: str, is_intermittent: bool,
                           lifecycle: str, policy: Policy) -> tuple[str, str]:
    """Rule-default model for a SKU's routing segment. Returns (model, key) where
    key names which segment_defaults entry was used (for the reason string)."""
    sd = policy.autopick.segment_defaults
    if is_intermittent or xyz == "Z":
        return policy.autopick.intermittent_default, "intermittent"
    if lifecycle == "dormant":
        return sd.dormant, "dormant"
    if lifecycle == "new":
        return sd.new, "new"
    if abc == "A":
        return sd.smooth_a, "smooth_a"
    if abc == "B":
        return sd.smooth_b, "smooth_b"
    return sd.global_default, "global_default"


def _override_clears(challenger: str, rule_default: str, seg_route: dict,
                     policy: Policy) -> tuple[bool, str]:
    """Does the backtest challenger clear the override bar vs the rule default?

    seg_route is the backtest_routing['segments'][segment] dict:
      {champion, fallback, val_wape, [bias_abs_pct], [beats_naive], [validated]}.
    Returns (clears, note). `note` explains a failure for the reason string.
    """
    ov = policy.autopick.override
    if challenger == rule_default:
        return False, "backtest champion equals the rule default"

    val_wape = seg_route.get("val_wape")
    if ov.require_validated and val_wape is None:
        return False, f"backtest challenger {challenger} was not validated"

    # relative WAPE gain vs the rule default. The routing table stores the
    # champion's val_wape; the rule default's val_wape is read from
    # backtest_routing when the same table scored it, else the challenger is
    # measured against the fallback's val_wape when present.
    default_wape = seg_route.get("rule_default_val_wape")
    if default_wape is None:
        default_wape = seg_route.get("fallback_val_wape")
    if val_wape is None or default_wape is None or default_wape <= 0:
        # no comparable baseline WAPE -> can't establish the margin -> keep rule
        return False, (f"backtest challenger {challenger} lacked a comparable "
                       "WAPE baseline to measure the override margin")
    gain = (default_wape - val_wape) / default_wape
    if gain < ov.min_relative_wape_gain:
        return False, (f"backtest challenger {challenger} beat the rule default by "
                       f"{gain * 100:.0f}% (< {ov.min_relative_wape_gain * 100:.0f}% "
                       "override margin)")

    bias = seg_route.get("bias_abs_pct")
    if bias is not None and abs(bias) > ov.max_bias_abs_pct:
        return False, (f"backtest challenger {challenger} biased "
                       f"{abs(bias):.0f}% (> {ov.max_bias_abs_pct:.0f}% cap)")

    if ov.require_beats_naive_floor and seg_route.get("beats_naive") is False:
        return False, f"backtest challenger {challenger} did not beat the naive floor"

    return True, (f"backtest challenger {challenger} cleared the override margin "
                  f"({gain * 100:.0f}% WAPE gain, validated)")


def _pick_model(segment: str, abc: str, xyz: str, is_intermittent: bool,
                lifecycle: str, policy: Policy,
                backtest_routing: dict | None) -> tuple[str, str, bool]:
    """(model, reason_fragment, from_validated_override). Rules first; the
    backtest only overrides when it clears the bar."""
    rule_model, key = _segment_default_model(
        segment, abc, xyz, is_intermittent, lifecycle, policy
    )
    frag = f"model {rule_model} is the {key} rule default"

    if backtest_routing is None:
        return rule_model, frag, False
    seg_map = backtest_routing.get("segments", {})
    seg_route = seg_map.get(segment)
    if not seg_route:
        return rule_model, frag, False
    challenger = str(seg_route.get("champion", "")) or rule_model

    # intermittent SKUs never take a combo champion
    if not _combo_ok(challenger, is_intermittent, policy):
        return (rule_model,
                f"{frag}; backtest champion {challenger} is a combo, excluded "
                "for intermittent SKUs",
                False)

    clears, note = _override_clears(challenger, rule_model, seg_route, policy)
    if clears:
        return challenger, f"backtest champion {challenger} overrides {rule_model}: {note}", True
    return rule_model, f"{frag}; {note}", False


def _confidence(action: str, from_validated_override: bool, strong_rule_default: bool,
                usable_weeks: int, censoring_ok: bool, thin: bool,
                policy: Policy) -> str:
    ds = policy.data_sufficiency
    if thin or action in ("pool_rule", "no_action", "run_down", "launch_watch"):
        # thin history / cluster-analog / rule-only handling
        if thin:
            return "low"
    # high requires validated (or strong rule default) + enough history + censoring ok
    if (from_validated_override or strong_rule_default) \
            and usable_weeks >= ds.min_weeks_validated and censoring_ok:
        return "high"
    if action in ("run_down", "no_action"):
        return "low"
    return "medium"


def decide(
    segments: pd.DataFrame,
    baseline: pd.DataFrame,
    panel: pd.DataFrame,
    policy: Policy,
    backtest_routing: dict | None = None,
    price_coverage_pct: float | None = None,
    has_category: bool = False,
    has_promo_calendar: bool = False,
) -> DecisionResult:
    """Produce one policy-driven decision per SKU-location. See module docstring
    for precedence and auto-pick semantics."""
    seg = segments.copy()
    for col, default in (("abc", "C"), ("xyz", "Z"), ("lifecycle", "active"),
                         ("intermittent_flag", False), ("segment", None)):
        if col not in seg.columns:
            seg[col] = default
    if seg["segment"].isna().all() if "segment" in seg else True:
        # derive routing segment if the segments frame didn't carry one
        def _route(r):
            if bool(r["intermittent_flag"]):
                return "intermittent"
            if r["lifecycle"] in ("new", "dormant"):
                return r["lifecycle"]
            return f"{r['abc']}{r['xyz']}"
        seg["segment"] = seg.apply(_route, axis=1)

    # baseline: usable_weeks per SKU-location
    bl = baseline[["sku", "location", "usable_weeks"]].copy() \
        if baseline is not None and len(baseline) else \
        pd.DataFrame(columns=["sku", "location", "usable_weeks"])
    seg = seg.merge(bl, on=_KEYS, how="left")
    seg["usable_weeks"] = seg["usable_weeks"].fillna(0).astype(int)

    ds = policy.data_sufficiency

    # --- non-zero-week count per SKU (for the data-sufficiency gate) ---------
    if panel is not None and len(panel) and "units_raw" in panel.columns:
        nz = (panel.assign(_nz=(panel["units_raw"].fillna(0) > 0))
              .groupby(_KEYS, as_index=False)["_nz"].sum()
              .rename(columns={"_nz": "nonzero_weeks"}))
        seg = seg.merge(nz, on=_KEYS, how="left")
    else:
        seg["nonzero_weeks"] = 0
    seg["nonzero_weeks"] = seg["nonzero_weeks"].fillna(0).astype(int)

    # trailing-52w revenue per SKU for the summary's revenue_share
    if panel is not None and len(panel) and "price_median" in panel.columns:
        p = panel.copy()
        p["week_start"] = pd.to_datetime(p["week_start"]) if "week_start" in p else pd.NaT
        max_week = p["week_start"].max() if "week_start" in p else pd.NaT
        recent = p if pd.isna(max_week) else p[p["week_start"] >= max_week - pd.Timedelta(weeks=51)]
        rev = (recent.assign(_rev=(recent["units_raw"] * recent["price_median"]).fillna(0.0))
               .groupby(_KEYS, as_index=False)["_rev"].sum()
               .rename(columns={"_rev": "revenue_52w"}))
        seg = seg.merge(rev, on=_KEYS, how="left")
    else:
        seg["revenue_52w"] = 0.0
    seg["revenue_52w"] = seg["revenue_52w"].fillna(0.0)

    # --- file-level assumptions (apply to every SKU) ------------------------
    file_assumptions: list[str] = []
    if price_coverage_pct is not None and price_coverage_pct < policy.price.min_price_coverage_pct:
        if policy.price.assume.missing_price == "units_only":
            file_assumptions.append(
                f"price coverage {price_coverage_pct:.0f}% below the "
                f"{policy.price.min_price_coverage_pct:.0f}% threshold; units-only, "
                "no money figures"
            )
        else:
            file_assumptions.append(
                f"price coverage {price_coverage_pct:.0f}% below threshold; money "
                "figures skipped"
            )
    if not has_promo_calendar:
        file_assumptions.append(
            "no promo calendar supplied; promos derived from price drops >= "
            f"{policy.promotions.price_drop_threshold_pct:.0f}%"
        )
    if not has_category:
        file_assumptions.append(
            "no category column; SKUs clustered by demand correlation for pooling"
        )

    censoring_ok = True  # v1: no stock snapshot, treat as ok unless flagged elsewhere

    records: list[dict] = []
    for _, r in seg.iterrows():
        abc = str(r["abc"])
        xyz = str(r["xyz"])
        life = str(r["lifecycle"])
        segment = str(r["segment"])
        is_intermittent = bool(r["intermittent_flag"])
        uw = int(r["usable_weeks"])
        nzw = int(r["nonzero_weeks"])

        assumptions = list(file_assumptions)
        thin = False

        # per-SKU history-too-short-for-selection assumption
        if uw < ds.min_weeks_backtest:
            assumptions.append(
                "history too short for model selection; using rule-default models"
            )

        # ---- 1. data-sufficiency gate --------------------------------------
        if uw < ds.min_weeks_forecastable and nzw < ds.min_nonzero_weeks:
            thin = True
            if ds.assume.thin_history == "cluster_analog":
                action = "pool_rule"
                model = policy.autopick.segment_defaults.new  # cluster_analog
                reason = (
                    f"not forecastable: only {uw} usable weeks (< "
                    f"{ds.min_weeks_forecastable}) and {nzw} non-zero weeks (< "
                    f"{ds.min_nonzero_weeks}); borrowing a cluster analog per "
                    "data_sufficiency.assume.thin_history=cluster_analog"
                )
                assumptions.append(
                    "thin history; forecast borrowed from a cluster/category analog"
                )
            else:
                action = "no_action"
                model = policy.autopick.segment_defaults.dormant  # 'none'
                reason = (
                    f"not forecastable: only {uw} usable weeks and {nzw} non-zero "
                    "weeks; no forecast per data_sufficiency.assume.thin_history="
                    "no_forecast"
                )
            stance = _STANCE_BY_ACTION[action]
            conf = _confidence(action, False, False, uw, censoring_ok, thin, policy)
            records.append(_row(r, action, model, stance, conf, reason, assumptions))
            continue

        # ---- 2. lifecycle ---------------------------------------------------
        if life == "dormant":
            action = policy.actions.dormant
            model = policy.autopick.segment_defaults.dormant
            reason = (
                f"lifecycle dormant (no sale in >= {policy.classification.dormancy_weeks} "
                f"weeks) -> {action}; no model, run down / write off"
            )
            stance = _STANCE_BY_ACTION.get(action, "none")
            conf = _confidence(action, False, False, uw, censoring_ok, thin, policy)
            records.append(_row(r, action, model, stance, conf, reason, assumptions))
            continue
        if life == "new":
            action = policy.actions.new
            model = policy.autopick.segment_defaults.new
            reason = (
                f"lifecycle new (first sale within {policy.classification.new_weeks} "
                f"weeks) -> {action}; launch curve, watch weekly"
            )
            stance = _STANCE_BY_ACTION.get(action, "launch")
            conf = _confidence(action, False, False, uw, censoring_ok, thin, policy)
            records.append(_row(r, action, model, stance, conf, reason, assumptions))
            continue

        # ---- 3. intermittency ----------------------------------------------
        if is_intermittent or xyz == "Z":
            if abc == "A":
                action = policy.actions.intermittent_high
                why = "high value but intermittent/erratic; buffer heavily"
            else:
                action = policy.actions.intermittent_other
                why = "intermittent/erratic, mid/low value; pool by category"
            model, pick_frag, validated = _pick_model(
                segment, abc, xyz, is_intermittent, life, policy, backtest_routing
            )
            reason = (
                f"intermittent/erratic (intermittent_flag={is_intermittent}, xyz={xyz}) "
                f"and abc={abc} -> {action}; {why}. {pick_frag}"
            )
            stance = _STANCE_BY_ACTION.get(action, "rule")
            conf = _confidence(action, validated, False, uw, censoring_ok, thin, policy)
            records.append(_row(r, action, model, stance, conf, reason, assumptions))
            continue

        # ---- 4. value x steadiness -----------------------------------------
        if abc == "A" and xyz == "X":
            action = policy.actions.a_steady
            strong = True
        elif abc == "A":
            action = policy.actions.a_variable
            strong = True
        elif abc == "B" and xyz == "X":
            action = policy.actions.b_steady
            strong = False
        else:
            action = policy.actions.default
            strong = False
        model, pick_frag, validated = _pick_model(
            segment, abc, xyz, is_intermittent, life, policy, backtest_routing
        )
        reason = (
            f"value x steadiness (abc={abc}, xyz={xyz}, active) -> {action}. {pick_frag}"
        )
        stance = _STANCE_BY_ACTION.get(action, "forecast")
        conf = _confidence(action, validated, strong, uw, censoring_ok, thin, policy)
        records.append(_row(r, action, model, stance, conf, reason, assumptions))

    per_sku = pd.DataFrame.from_records(records)

    # --- summary by action --------------------------------------------------
    if len(per_sku):
        rev = seg[_KEYS + ["revenue_52w"]]
        merged = per_sku.merge(rev, on=_KEYS, how="left")
        merged["revenue_52w"] = merged["revenue_52w"].fillna(0.0)
        total = merged["revenue_52w"].sum()
        summary = (merged.groupby("action", as_index=False)
                   .agg(n_skus=("sku", "count"), revenue_52w=("revenue_52w", "sum")))
        summary["revenue_share"] = (summary["revenue_52w"] / total) if total else (
            1.0 / len(summary) if len(summary) else 0.0
        )
        summary = summary[["action", "n_skus", "revenue_share"]] \
            .sort_values("n_skus", ascending=False).reset_index(drop=True)
    else:
        summary = pd.DataFrame(columns=["action", "n_skus", "revenue_share"])

    # --- catalogue-level dedup'd assumptions --------------------------------
    seen: list[str] = []
    for a in per_sku.get("assumptions", pd.Series(dtype=str)):
        for part in str(a).split("; "):
            if part and part not in seen:
                seen.append(part)

    return DecisionResult(
        per_sku=per_sku,
        summary=summary,
        assumptions=seen,
        policy_version=int(policy.version),
    )


def _row(r, action, model, stance, confidence, reason, assumptions) -> dict:
    return {
        "sku": r["sku"],
        "location": r["location"],
        "action": action,
        "model": model,
        "stance": stance,
        "confidence": confidence,
        "reason": reason,
        "assumptions": "; ".join(assumptions),
    }
