"""FastAPI web layer over the audit engine.

Runs the same pipeline as ``audit run`` (see cli.py) but launched from HTTP
endpoints, with the pipeline executing in a background thread and artifacts
served from ``runs/{client}/{run_id}/``.  This module owns no engine logic —
it imports and calls the same functions the CLI does.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import yaml
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from .config import load_config
from .models.catalog import catalog, default_roster_ids, valid_ids

PROJECT_ROOT = Path(__file__).resolve().parents[2]
RUNS_ROOT = PROJECT_ROOT / "runs"
DEFAULTS = PROJECT_ROOT / "config" / "defaults.yaml"

_SAFE_SEGMENT = re.compile(r"^[A-Za-z0-9_.-]+$")
_TERMINAL = ("complete", "halted", "failed")

# ---------------------------------------------------------------------------
# in-memory run registry (merged with a disk scan for listing/status)
# ---------------------------------------------------------------------------

_registry: dict[tuple[str, str], dict[str, Any]] = {}
_registry_lock = threading.Lock()
_executor = ThreadPoolExecutor(max_workers=2)


def _set_status(client: str, run_id: str, **fields: Any) -> None:
    with _registry_lock:
        entry = _registry.setdefault(
            (client, run_id),
            {
                "client": client,
                "run_id": run_id,
                "status": "running",
                "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "error": None,
            },
        )
        entry.update(fields)


def _get_registry_entry(client: str, run_id: str) -> dict[str, Any] | None:
    with _registry_lock:
        entry = _registry.get((client, run_id))
        return dict(entry) if entry else None


# ---------------------------------------------------------------------------
# app + CORS
# ---------------------------------------------------------------------------

app = FastAPI(title="audit-engine API", version="0.1.0")

_origins = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins or ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _sanitize_client(name: str) -> str:
    cleaned = re.sub(r"[^a-z0-9_-]+", "-", (name or "").lower()).strip("-_")
    return cleaned[:64] or "client"


def _validate_segment(value: str, what: str) -> str:
    if not _SAFE_SEGMENT.match(value or "") or value.strip(".") == "":
        raise HTTPException(status_code=400, detail=f"invalid {what}")
    return value


def _run_dir(client: str, run_id: str, must_exist: bool = True) -> Path:
    _validate_segment(client, "client")
    _validate_segment(run_id, "run_id")
    root = RUNS_ROOT.resolve()
    path = (RUNS_ROOT / client / run_id).resolve()
    if root not in path.parents:
        raise HTTPException(status_code=400, detail="path escapes runs root")
    if must_exist and not path.is_dir():
        raise HTTPException(status_code=404, detail="run not found")
    return path


def _write_status_file(run_dir: Path, status: str, error: str | None = None) -> None:
    try:
        run_dir.mkdir(parents=True, exist_ok=True)
        payload: dict[str, Any] = {"status": status}
        if error:
            payload["error"] = error
        (run_dir / "status.json").write_text(json.dumps(payload), encoding="utf-8")
    except OSError:
        pass  # never let bookkeeping kill the worker's error path


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _read_manifest(run_dir: Path) -> dict[str, Any] | None:
    path = run_dir / "manifest.yaml"
    if not path.is_file():
        return None
    try:
        loaded = yaml.safe_load(path.read_text(encoding="utf-8"))
        return loaded if isinstance(loaded, dict) else None
    except (OSError, yaml.YAMLError):
        return None


def _disk_status(run_dir: Path) -> tuple[str, str | None]:
    """Best-effort status from artifacts on disk: (status, error)."""
    status = _read_json(run_dir / "status.json")
    if status and status.get("status"):
        return str(status["status"]), status.get("error")
    if (run_dir / "report" / "report.html").is_file():
        return "complete", None
    manifest = _read_manifest(run_dir)
    if manifest and manifest.get("halted"):
        return "halted", None
    return "unknown", None


def _merged_status(client: str, run_id: str, run_dir: Path) -> tuple[str, str | None]:
    disk, error = _disk_status(run_dir)
    if disk != "unknown":
        return disk, error
    entry = _get_registry_entry(client, run_id)
    if entry:
        return entry["status"], entry.get("error")
    return "unknown", None


def _created_iso(run_id: str, run_dir: Path) -> str:
    stamp = run_id.split("_", 1)[0]
    try:
        return (
            datetime.strptime(stamp, "%Y%m%dT%H%M%SZ")
            .replace(tzinfo=timezone.utc)
            .isoformat(timespec="seconds")
        )
    except ValueError:
        try:
            mtime = run_dir.stat().st_mtime
            return datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat(timespec="seconds")
        except OSError:
            return ""


def _parse_ids(raw: str | None) -> list[str]:
    """Parse a comma-separated id string into a validated list.

    Unknown ids (not in models.catalog.valid_ids()) are silently dropped.
    Order is preserved and duplicates removed. Empty/absent => [].
    """
    if not raw:
        return []
    known = valid_ids()
    out: list[str] = []
    seen: set[str] = set()
    for token in raw.split(","):
        tok = token.strip()
        if tok and tok in known and tok not in seen:
            out.append(tok)
            seen.add(tok)
    return out


def _num(value: Any) -> float | int | None:
    """Coerce numpy scalars/NaN to plain JSON-safe numbers."""
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if f != f:  # NaN
        return None
    return int(f) if f.is_integer() and abs(f) < 1e15 else f


# ---------------------------------------------------------------------------
# background pipeline (mirrors cli.run — same calls, same artifact layout)
# ---------------------------------------------------------------------------

class _RunHalted(Exception):
    def __init__(self, reasons: list[str]):
        super().__init__("; ".join(reasons) or "Phase 0 no-go")
        self.reasons = reasons


def _execute(ctx, cfg, sales_path: Path, stock_path: Path | None, with_models: bool) -> dict:
    """The `audit run` pipeline; returns the summary dict. Raises _RunHalted on no-go."""
    from .availability.inferred import InferredAvailability
    from .baseline.baseline import compute_baseline
    from .baseline.segments import compute_segments
    from .clean.pipeline import run_chain
    from .cli import _build_report_context, _workbook_sheets
    from .findings.catalogue import catalogue_structure
    from .findings.data_quality import data_quality_findings
    from .findings.lost_sales import lost_sales, repeat_offenders
    from .findings.stock_position import stock_position
    from .ingest.health import render_health_text, run_health
    from .ingest.loaders import load_sales, load_stock
    from .report.html import render_report
    from .report.workbook import write_workbook

    tx = load_sales(sales_path, cfg)
    ctx.snapshot_input(sales_path)
    stock_df = None
    if stock_path is not None:
        stock_df = load_stock(stock_path, cfg)
        ctx.snapshot_input(stock_path)

    health_report = run_health(tx, stock_df, cfg)
    (ctx.root / "health.md").write_text(render_health_text(health_report), encoding="utf-8")
    if health_report.verdict == "no_go":
        ctx.write_manifest({"halted": True, "halt_reasons": health_report.halt_reasons})
        raise _RunHalted(list(health_report.halt_reasons))

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
    dq = data_quality_findings(health_report.to_dict(), clean.audit_log, cfg)

    nested = None
    if with_models:
        from .models.registry import build_roster
        from .panel import build_matrices
        from .selection.nested import run_nested

        mats = build_matrices(clean.panel)
        nested = run_nested(mats, lambda: build_roster(cfg), cfg, segments, ctx.root)

    context = _build_report_context(ctx, cfg, health_report, ls, ro, sp, cat, dq, nested, clean, segments)
    report_path = render_report(context, ctx.report_dir / "report.html")
    sheets = _workbook_sheets(clean, baseline, segments, ls, ro, sp)
    wb_path = write_workbook(ctx.report_dir / "sku_detail.xlsx", sheets)
    ctx.write_manifest({"report": str(report_path), "workbook": str(wb_path)})

    total = ls.get("total") or {}
    capital = (sp or {}).get("capital") or {}
    return {
        "lost_units_low": _num(total.get("units_low")),
        "lost_units_high": _num(total.get("units_high")),
        "lost_revenue_low": _num(total.get("revenue_low")),
        "lost_revenue_high": _num(total.get("revenue_high")),
        "episodes": int(len(clean.episodes)),
        "dead_stock_value": _num(capital.get("dead_stock_value")),
        "overstock_value": _num(capital.get("overstock_value")),
        "total_stock_value": _num(capital.get("total_stock_value")),
        "n_skus": int(clean.panel["sku"].nunique()) if len(clean.panel) else 0,
        "routing_tier": (nested or {}).get("tier"),
        "routing": (nested or {}).get("routing"),
        "selected_models": list(cfg.models.selected_models),
        "selected_combos": list(cfg.models.selected_combos),
    }


def _run_job(
    ctx,
    cfg,
    prepare: Callable[[], tuple[Path, Path | None]],
    with_models: bool,
    cleanup_dir: Path | None,
) -> None:
    """Background worker: prepare inputs, run the pipeline, persist terminal state."""
    client, run_id = ctx.client, ctx.run_id
    try:
        sales_path, stock_path = prepare()
        summary = _execute(ctx, cfg, sales_path, stock_path, with_models)
        (ctx.root / "summary.json").write_text(json.dumps(summary), encoding="utf-8")
        _write_status_file(ctx.root, "complete")
        _set_status(client, run_id, status="complete", error=None)
    except _RunHalted as halt:
        _write_status_file(ctx.root, "halted", error=None)
        _set_status(client, run_id, status="halted", error=str(halt))
    except Exception as exc:  # noqa: BLE001 — a failed run must never crash the server
        detail = f"{type(exc).__name__}: {exc}"
        traceback.print_exc()
        _write_status_file(ctx.root, "failed", error=detail)
        _set_status(client, run_id, status="failed", error=detail)
    finally:
        if cleanup_dir is not None:
            shutil.rmtree(cleanup_dir, ignore_errors=True)


def _launch_run(
    client: str,
    with_models: bool,
    prepare: Callable[[], tuple[Path, Path | None]],
    cleanup_dir: Path | None,
    models: list[str] | None = None,
    combos: list[str] | None = None,
) -> dict[str, str]:
    """Create the run identity synchronously, then hand off to the executor."""
    from .runctx import RunContext

    cfg = load_config(DEFAULTS, None)
    cfg.client = client
    cfg.models.selected_models = models or []
    cfg.models.selected_combos = combos or []
    ctx = RunContext(cfg, runs_root=RUNS_ROOT, client=client)
    _set_status(client, ctx.run_id, status="running")
    _write_status_file(ctx.root, "running")
    _executor.submit(_run_job, ctx, cfg, prepare, with_models, cleanup_dir)
    return {"client": client, "run_id": ctx.run_id, "status": "running"}


# ---------------------------------------------------------------------------
# endpoints
# ---------------------------------------------------------------------------

@app.get("/api/health")
def api_health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/models")
def api_models() -> dict[str, Any]:
    return {"models": catalog(), "defaults": default_roster_ids()}


@app.post("/api/runs", status_code=202)
def create_run(
    sales: UploadFile = File(...),
    stock: UploadFile | None = File(None),
    client: str = Form("client"),
    with_models: bool = Form(True),
    models: str | None = Form(None),
    combos: str | None = Form(None),
) -> JSONResponse:
    client_name = _sanitize_client(client)
    selected_models = _parse_ids(models)
    selected_combos = _parse_ids(combos)
    upload_dir = Path(tempfile.mkdtemp(prefix="audit_api_upload_"))
    try:
        sales_path = upload_dir / "sales.csv"
        with open(sales_path, "wb") as out:
            shutil.copyfileobj(sales.file, out)
        stock_path: Path | None = None
        if stock is not None and stock.filename:
            stock_path = upload_dir / "stock.csv"
            with open(stock_path, "wb") as out:
                shutil.copyfileobj(stock.file, out)
    except Exception:
        shutil.rmtree(upload_dir, ignore_errors=True)
        raise HTTPException(status_code=400, detail="could not read uploaded files")

    body = _launch_run(
        client_name,
        with_models,
        prepare=lambda: (sales_path, stock_path),
        cleanup_dir=upload_dir,
        models=selected_models,
        combos=selected_combos,
    )
    return JSONResponse(status_code=202, content=body)


@app.post("/api/demo", status_code=202)
def create_demo_run(
    with_models: bool = Form(True),
    models: str | None = Form(None),
    combos: str | None = Form(None),
) -> JSONResponse:
    demo_dir = Path(tempfile.mkdtemp(prefix="audit_api_demo_"))
    selected_models = _parse_ids(models)
    selected_combos = _parse_ids(combos)

    def prepare() -> tuple[Path, Path | None]:
        from .synth.generator import generate

        result = generate(scenario="full")
        paths = result.write_csvs(demo_dir)
        return paths["sales"], paths.get("stock")

    body = _launch_run(
        "demo",
        with_models,
        prepare=prepare,
        cleanup_dir=demo_dir,
        models=selected_models,
        combos=selected_combos,
    )
    return JSONResponse(status_code=202, content=body)


@app.get("/api/runs")
def list_runs() -> list[dict[str, Any]]:
    items: dict[tuple[str, str], dict[str, Any]] = {}
    if RUNS_ROOT.is_dir():
        for client_dir in sorted(RUNS_ROOT.iterdir()):
            if not client_dir.is_dir() or not _SAFE_SEGMENT.match(client_dir.name):
                continue
            for run_dir in sorted(client_dir.iterdir()):
                if not run_dir.is_dir() or not _SAFE_SEGMENT.match(run_dir.name):
                    continue
                client, run_id = client_dir.name, run_dir.name
                status, _error = _merged_status(client, run_id, run_dir)
                items[(client, run_id)] = {
                    "client": client,
                    "run_id": run_id,
                    "status": status,
                    "created": _created_iso(run_id, run_dir),
                    "has_report": (run_dir / "report" / "report.html").is_file(),
                }
    # registry entries whose dirs have not appeared on disk yet
    with _registry_lock:
        registry_snapshot = {k: dict(v) for k, v in _registry.items()}
    for (client, run_id), entry in registry_snapshot.items():
        if (client, run_id) not in items:
            items[(client, run_id)] = {
                "client": client,
                "run_id": run_id,
                "status": entry["status"],
                "created": entry.get("created", ""),
                "has_report": False,
            }
    return sorted(items.values(), key=lambda r: r["created"], reverse=True)


@app.get("/api/runs/{client}/{run_id}")
def run_status(client: str, run_id: str) -> dict[str, Any]:
    run_dir = _run_dir(client, run_id)
    status, error = _merged_status(client, run_id, run_dir)
    return {
        "status": status,
        "manifest": _read_manifest(run_dir),
        "summary": _read_json(run_dir / "summary.json"),
        "error": error,
    }


def _artifact_response(
    client: str, run_id: str, relative: str, media_type: str, download_name: str | None = None
) -> FileResponse:
    run_dir = _run_dir(client, run_id)
    path = run_dir / relative
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"{relative} not found for this run")
    kwargs: dict[str, Any] = {"media_type": media_type}
    if download_name:
        kwargs["filename"] = download_name
    return FileResponse(path, **kwargs)


@app.get("/api/runs/{client}/{run_id}/report")
def run_report(client: str, run_id: str) -> FileResponse:
    return _artifact_response(client, run_id, "report/report.html", "text/html")


@app.get("/api/runs/{client}/{run_id}/workbook")
def run_workbook(client: str, run_id: str) -> FileResponse:
    return _artifact_response(
        client,
        run_id,
        "report/sku_detail.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        download_name="sku_detail.xlsx",
    )


@app.get("/api/runs/{client}/{run_id}/health-md")
def run_health_md(client: str, run_id: str) -> FileResponse:
    return _artifact_response(client, run_id, "health.md", "text/markdown")


@app.get("/api/runs/{client}/{run_id}/routing")
def run_routing(client: str, run_id: str) -> dict[str, Any]:
    run_dir = _run_dir(client, run_id)
    path = run_dir / "routing_table.yaml"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="routing table not found for this run")
    try:
        loaded = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError):
        raise HTTPException(status_code=500, detail="could not read routing table")
    if not isinstance(loaded, dict):
        raise HTTPException(status_code=404, detail="routing table empty or malformed")
    return loaded
