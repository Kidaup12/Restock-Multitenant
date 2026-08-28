"""CLI entry points: audit health / run / synth / backtest."""
from __future__ import annotations

from pathlib import Path

import pandas as pd
import typer

from .config import Config, load_config

app = typer.Typer(help="Retail inventory audit engine", no_args_is_help=True)

DEFAULTS = Path(__file__).resolve().parents[2] / "config" / "defaults.yaml"


def _cfg(client_config: Path | None, client: str | None) -> Config:
    cfg = load_config(DEFAULTS, client_config)
    if client:
        cfg.client = client
    return cfg


@app.command()
def synth(
    scenario: str = typer.Option("full", help="full|clean|stockouts_only|closures|promos|intermittent|proc_*"),
    seed: int = 42,
    n_weeks: int = 104,
    out: Path = typer.Option(Path("data/synth"), help="Output directory for CSVs"),
):
    """Generate a synthetic dataset with planted faults and known truth."""
    from .synth.generator import generate

    result = generate(scenario=scenario, seed=seed, n_weeks=n_weeks)
    paths = result.write_csvs(out)
    for name, p in paths.items():
        typer.echo(f"  {name}: {p}")
    typer.echo(f"synth '{scenario}' written to {out}")


@app.command()
def health(
    sales: Path = typer.Argument(..., help="Sales lines CSV"),
    stock: Path = typer.Option(None, help="Current stock-on-hand CSV"),
    client_config: Path = typer.Option(None, help="Client override YAML"),
):
    """Phase 0 data health audit: go/no-go plus findings."""
    from .ingest.health import render_health_text, run_health
    from .ingest.loaders import load_sales, load_stock

    cfg = _cfg(client_config, None)
    tx = load_sales(sales, cfg)
    stock_df = load_stock(stock, cfg) if stock else None
    report = run_health(tx, stock_df, cfg)
    typer.echo(render_health_text(report))
    if report.verdict == "no_go":
        raise typer.Exit(code=1)


@app.command()
def run(
    sales: Path = typer.Argument(..., help="Sales lines CSV"),
    stock: Path = typer.Option(None, help="Current stock-on-hand CSV"),
    client_config: Path = typer.Option(None, help="Client override YAML"),
    client: str = typer.Option("client", help="Client name for the runs/ directory"),
    with_models: bool = typer.Option(True, help="Run the model-selection harness (Phase B)"),
    force: bool = typer.Option(False, help="Proceed past a no-go health verdict"),
):
    """Full audit: health -> clean -> findings -> (optional) model selection -> report."""
    from .availability.inferred import InferredAvailability
    from .baseline.baseline import compute_baseline
    from .baseline.segments import compute_segments
    from .clean.pipeline import run_chain
    from .findings.catalogue import catalogue_structure
    from .findings.playbook import playbook
    from .findings.data_quality import data_quality_findings
    from .findings.lost_sales import lost_sales, repeat_offenders
    from .findings.stock_position import stock_position
    from .ingest.health import render_health_text, run_health
    from .ingest.loaders import load_sales, load_stock
    from .report.html import render_report
    from .report.workbook import write_workbook
    from .runctx import RunContext

    cfg = _cfg(client_config, client)
    ctx = RunContext(cfg, client=client)
    typer.echo(f"run_id: {ctx.run_id}")

    tx = load_sales(sales, cfg)
    ctx.snapshot_input(sales)
    stock_df = None
    if stock:
        stock_df = load_stock(stock, cfg)
        ctx.snapshot_input(stock)

    health_report = run_health(tx, stock_df, cfg)
    (ctx.root / "health.md").write_text(render_health_text(health_report), encoding="utf-8")
    if health_report.verdict == "no_go" and not force:
        typer.echo("HALT: Phase 0 no-go. Deliverable is the data health report (health.md).")
        typer.echo(render_health_text(health_report))
        ctx.write_manifest({"halted": True, "halt_reasons": health_report.halt_reasons})
        raise typer.Exit(code=1)

    clean = run_chain(tx, cfg, InferredAvailability())
    clean.panel.to_parquet(ctx.tables / "panel.parquet", index=False)
    clean.audit_log.to_parquet(ctx.tables / "audit_log.parquet", index=False)
    clean.episodes.to_parquet(ctx.tables / "episodes.parquet", index=False)

    baseline = compute_baseline(clean.panel, cfg)
    segments = compute_segments(clean.panel, cfg)
    baseline.to_parquet(ctx.tables / "baseline.parquet", index=False)
    segments.to_parquet(ctx.tables / "segments.parquet", index=False)

    ls = lost_sales(clean.episodes, baseline, clean.panel, cfg)
    ro = repeat_offenders(clean.episodes, cfg, baseline=baseline, panel=clean.panel)
    sp = stock_position(stock_df, baseline, clean.panel, segments, cfg) if stock_df is not None else None
    cat = catalogue_structure(segments, clean.panel, cfg)
    pb = playbook(segments, clean.panel, cfg)
    pb["per_sku"].to_parquet(ctx.tables / "playbook.parquet", index=False)
    dq = data_quality_findings(health_report.to_dict(), clean.audit_log, cfg)

    nested = None
    if with_models:
        from .models.registry import build_roster
        from .panel import build_matrices
        from .selection.nested import run_nested

        mats = build_matrices(clean.panel)
        nested = run_nested(mats, lambda: _make_roster(cfg), cfg, segments, ctx.root)

    # Forward test of the chosen models (surfaces the rolling-origin backtest).
    ft = None
    if nested is not None:
        from .findings.forward_test import forward_test

        all_scores = pd.concat(
            [nested.get("sel_scores"), nested.get("val_scores")], ignore_index=True
        )
        ft = forward_test(all_scores, segments, nested.get("routing") or {})

    # Policy-driven per-SKU decisions (rules first, backtest breaks ties).
    from .decisions import decide
    from .policy import load_policy

    policy = load_policy(DEFAULTS.parent / "policy.yaml")
    routing = _enrich_routing(nested, cfg) if nested else None
    price_cov = _price_coverage_pct(tx)
    decisions = decide(
        segments, baseline, clean.panel, policy,
        backtest_routing=routing,
        price_coverage_pct=price_cov,
        has_category=("category" in tx.columns and tx["category"].notna().any()),
        has_promo_calendar=False,
    )
    decisions.per_sku.to_parquet(ctx.tables / "decisions.parquet", index=False)

    if ft is not None:
        ft["by_segment"].to_parquet(ctx.tables / "forward_test_by_segment.parquet", index=False)
        ft["by_origin"].to_parquet(ctx.tables / "forward_test_by_origin.parquet", index=False)

    context = _build_report_context(ctx, cfg, health_report, ls, ro, sp, cat, dq, nested, clean, segments, pb, decisions, ft)
    report_path = render_report(context, ctx.report_dir / "report.html")
    sheets = _workbook_sheets(clean, baseline, segments, ls, ro, sp, pb, decisions, ft)
    wb_path = write_workbook(ctx.report_dir / "sku_detail.xlsx", sheets)
    ctx.write_manifest({"report": str(report_path), "workbook": str(wb_path)})
    typer.echo(f"report:   {report_path}")
    typer.echo(f"workbook: {wb_path}")


@app.command()
def backtest(
    sales: Path = typer.Argument(..., help="Sales lines CSV"),
    client_config: Path = typer.Option(None, help="Client override YAML"),
    inner_only: bool = typer.Option(True, help="Selection block only (dev mode); full nested touches the validation block once"),
    out: Path = typer.Option(Path("runs/_backtest"), help="Output directory"),
):
    """Model-selection harness only, for development iteration."""
    from .availability.inferred import InferredAvailability
    from .baseline.segments import compute_segments
    from .clean.pipeline import run_chain
    from .ingest.loaders import load_sales
    from .models.registry import build_roster
    from .panel import build_matrices
    from .selection.harness import run_backtest
    from .selection.nested import run_nested
    from .selection.scoring import score_frame

    cfg = _cfg(client_config, None)
    tx = load_sales(sales, cfg)
    clean = run_chain(tx, cfg, InferredAvailability())
    mats = build_matrices(clean.panel)
    segments = compute_segments(clean.panel, cfg)
    out.mkdir(parents=True, exist_ok=True)
    if inner_only:
        result = run_backtest(mats, lambda: _make_roster(cfg), cfg, segments, blocks=("selection",))
        result.scores.to_parquet(out / "scores_inner.parquet", index=False)
        typer.echo(score_frame(result.scores).to_string())
        typer.echo(f"tier={result.tier} excluded_pct={result.excluded_pct:.1f}")
    else:
        nested = run_nested(mats, lambda: _make_roster(cfg), cfg, segments, out)
        typer.echo(f"nested run complete: tier={nested.get('tier')}; artifacts in {out}")


def _records(df) -> list[dict]:
    return df.to_dict("records") if df is not None and len(df) else []


def _price_coverage_pct(tx) -> float:
    """% of sale lines with a usable (>0) price. Drives the money-figures assumption."""
    if "unit_price" not in tx.columns or len(tx) == 0:
        return 0.0
    p = tx["unit_price"]
    return float((p.notna() & (p > 0)).mean() * 100)


def _enrich_routing(nested: dict, cfg) -> dict | None:
    """Add each segment's rule-default WAPE + the champion's bias to the routing
    dict so decisions.py's auto-pick override can actually compare a challenger
    against the rule default (see DECISION_POLICY.md §6)."""
    if not nested:
        return None
    routing = dict(nested.get("routing") or {})
    segs = dict(routing.get("segments") or {})
    val = nested.get("val_scores")
    if val is None or not len(val):
        routing["segments"] = segs
        return routing

    from .policy import load_policy

    pol = load_policy(DEFAULTS.parent / "policy.yaml")
    sd = pol.autopick.segment_defaults
    seg_default_model = {
        "intermittent": sd.intermittent, "smooth_a": sd.smooth_a, "smooth_b": sd.smooth_b,
        "erratic": sd.erratic, "global_default": sd.global_default,
    }
    v = val[val["scored"]].copy()
    v["ae"] = (v["y_true"] - v["y_pred"]).abs()
    g = v.groupby("model_id").agg(ae=("ae", "sum"), vol=("y_true", lambda x: x.abs().sum()),
                                  pred=("y_pred", "sum"), true=("y_true", "sum"))
    wape = (g["ae"] / g["vol"]).to_dict()
    bias = (100 * (g["pred"] - g["true"]) / g["vol"]).to_dict()

    for seg, d in segs.items():
        rule_model = seg_default_model.get(seg, sd.global_default)
        d["rule_default_val_wape"] = round(wape[rule_model], 4) if rule_model in wape else None
        champ = d.get("champion")
        if champ in bias:
            d["bias_abs_pct"] = round(abs(bias[champ]), 2)
    routing["segments"] = segs
    return routing


def _routing_context(nested_result: dict | None) -> dict | None:
    """Adapt run_nested()'s routing dict to the template's {table, note} shape."""
    if not nested_result:
        return None
    routing = nested_result.get("routing") or {}
    segments = routing.get("segments") or {}
    tier = nested_result.get("tier", "unknown")
    if not segments:
        return {"table": [], "note": f"History tier '{tier}': model selection not possible; "
                                     f"default champion {routing.get('default_champion', 'M5')}."}
    table = []
    for seg, d in sorted(segments.items()):
        vw = d.get("val_wape")
        table.append({
            "segment": seg,
            "champion": d.get("champion"),
            "fallback": d.get("fallback"),
            "n_skus": d.get("n_skus"),
            "evidence": f"validation WAPE {vw:.3f}" if vw is not None else "selection block only (unvalidated)",
        })
    note = (f"Status: {routing.get('status', 'provisional')}; history tier: {tier}; "
            f"default champion {routing.get('default_champion')}, floor {routing.get('floor_model')}.")
    return {"table": table, "note": note}


def _make_roster(cfg: Config) -> dict:
    """Assemble the harness roster from config, honouring any frontend/API selection.

    - Base models: cfg.models.selected_models if the user picked any, else
      cfg.models.roster (the spec default M1-M10). Ids validated against the
      catalog; unknown/unbuildable ids are skipped.
    - Combos: cfg.models.selected_combos if picked, else cfg.combinations.enabled.
      C1 uses cfg.combinations.members_c1; CC01-CC20 come from combo_registry.
      Each combo wraps FRESH member instances so no fitted state is shared.

    Segment-routing (C5) is produced by the selection strategies, not scored as
    a model; two-layer combos needing an event layer are handled in combo_registry.
    """
    from .models.catalog import valid_ids
    from .models.combos import MedianCombo
    from .models.registry import _build, build_roster

    ok = valid_ids()

    # --- base models ---
    model_ids = cfg.models.selected_models or cfg.models.roster
    roster: dict = {}
    for mid in model_ids:
        if mid not in ok:
            continue
        try:
            roster[mid] = _build(mid, cfg)
        except (KeyError, Exception):  # noqa: BLE001
            continue

    # --- combinations ---
    combo_ids = cfg.models.selected_combos or cfg.combinations.enabled
    want = set(combo_ids)
    if "C1" in want:
        pool = build_roster(cfg)
        members = [pool[m] for m in cfg.combinations.members_c1 if m in pool]
        if len(members) >= 2:
            roster["C1"] = MedianCombo(members, model_id="C1")
        want.discard("C1")
    cc = {c for c in want if c.startswith("CC")}
    if cc:
        try:
            from .models.combo_registry import build_combo_roster

            built = build_combo_roster(cfg)
            built = built[0] if isinstance(built, tuple) else built
            for cid in cc:
                if cid in built:
                    roster[cid] = built[cid]
        except Exception:  # noqa: BLE001
            pass
    return roster


def _build_report_context(ctx, cfg, health_report, ls, ro, sp, cat, dq, nested_result, clean, segments, pb=None, decisions=None, ft=None) -> dict:
    from datetime import date

    limitations = [
        "Stockout days are inferred from sales gaps, not measured from stock records; "
        "stockouts shorter than the detection threshold are invisible.",
        "SKUs selling below ~1 unit/day are not assessable for stockouts and are excluded "
        "from lost-sales money figures (an allowance is included in the upper band).",
        "Days where a large share of the catalogue sold zero were treated as closures and "
        "excluded from all lost-sales claims.",
        "All money figures are ranges under stated assumptions, not measurements.",
    ]
    share = (ls.get("total") or {}).get("not_assessable_value_share")
    if share:
        limitations.append(
            f"Not-assessable SKUs represent roughly {share:.0%} of trailing revenue."
        )

    stock_ctx = None
    if sp is not None:
        capital = sp["capital"]
        dead = sp["dead_stock"]
        if len(dead):
            dead_buckets = (
                dead.groupby("bucket", observed=True)
                .agg(n_skus=("sku", "nunique"), units=("qty_on_hand", "sum"), value=("value", "sum"))
                .reset_index().to_dict("records")
            )
        else:
            dead_buckets = []
        stock_ctx = {
            "cover_buckets": _records(sp["cover_buckets"]),
            "dead_stock": {
                "buckets": dead_buckets,
                "total_value": capital.get("dead_stock_value"),
                "total_units": capital.get("dead_stock_units"),
                "threshold_weeks": cfg.findings.dead_stock_weeks[0],
            },
            "overstock_value": capital.get("overstock_value"),
            "total_stock_value": capital.get("total_stock_value"),
        }

    return {
        "client": ctx.client,
        "run_id": ctx.run_id,
        "generated": date.today().isoformat(),
        "immediate_actions": {
            "runouts": _records(sp["runouts"]) if sp is not None else [],
            "repeat_offenders": _records(ro),
        },
        "lost_sales": {
            "total": ls.get("total"),
            "by_month": _records(ls.get("by_month")),
            "top_skus": _records(ls.get("by_sku")),
            "method_note": None,
        },
        "stock_position": stock_ctx,
        "catalogue": cat,
        "playbook": {
            "by_action": _records(pb["by_action"]),
            "a_breakout": _records(pb["a_breakout"]),
        } if pb is not None else None,
        "decisions": {
            "summary": _records(decisions.summary),
            "assumptions": list(decisions.assumptions),
            "examples": _records(decisions.per_sku[["sku", "action", "model", "confidence", "reason"]].head(15)),
            "policy_version": decisions.policy_version,
        } if decisions is not None else None,
        "routing": _routing_context(nested_result),
        "forward_test": {
            "headline": ft["headline"],
            "by_segment": _records(ft["by_segment"]),
            "by_origin": _records(ft["by_origin"]),
            "by_horizon": _records(ft["by_horizon"]),
            "note": ft["note"],
        } if ft is not None else None,
        "data_quality": dq,
        "limitations": limitations,
        "recommendations": [
            "Set reorder points on the repeat-offender SKUs listed in Immediate Actions.",
            "Start a daily stock snapshot (date, sku, location, qty_on_hand) today — it cannot "
            "be backfilled, and 12 weeks of it turns these ranges into measured numbers.",
            "Re-audit after 12 weeks of snapshots to validate the inferred stockouts.",
        ],
    }


def _workbook_sheets(clean, baseline, segments, ls, ro, sp, pb=None, decisions=None, ft=None) -> dict:
    sheets = {
        "baseline": baseline,
        "segments": segments,
        "stockout_episodes": clean.episodes,
        "audit_log": clean.audit_log,
    }
    if ft is not None:
        sheets["forward_test_by_segment"] = ft["by_segment"]
        sheets["forward_test_by_origin"] = ft["by_origin"]
    if decisions is not None and getattr(decisions, "per_sku", None) is not None:
        sheets["decisions"] = decisions.per_sku
    if pb is not None and pb.get("per_sku") is not None:
        sheets["playbook"] = pb["per_sku"]
    if isinstance(ls, dict) and ls.get("by_sku") is not None:
        sheets["lost_sales_by_sku"] = ls["by_sku"]
    if ro is not None:
        sheets["repeat_offenders"] = ro
    if sp:
        for key in ("cover", "dead_stock", "runouts"):
            if sp.get(key) is not None:
                sheets[key] = sp[key]
    return sheets


if __name__ == "__main__":
    app()
