"""Tests for the FastAPI web layer (audit_engine.api).

Note: starlette's TestClient requires the httpx package, which is not part of
this project's locked dependencies. The app is instead served by a real
uvicorn server on a background thread and exercised with stdlib urllib —
an end-to-end test of the same ASGI app.
"""
from __future__ import annotations

import json
import shutil
import socket
import threading
import time
import urllib.error
import urllib.request
from datetime import date, timedelta
from pathlib import Path

import pytest
import uvicorn

from audit_engine import api

TERMINAL = ("complete", "halted", "failed")
TEST_CLIENT_NAME = "apitest"


# ---------------------------------------------------------------------------
# server fixture + tiny stdlib HTTP client
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def base_url():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()

    config = uvicorn.Config(api.app, host="127.0.0.1", port=port, log_level="warning")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 15
    while not server.started:
        if time.time() > deadline:
            raise RuntimeError("uvicorn failed to start")
        time.sleep(0.05)

    yield f"http://127.0.0.1:{port}"

    server.should_exit = True
    thread.join(timeout=10)
    shutil.rmtree(api.RUNS_ROOT / TEST_CLIENT_NAME, ignore_errors=True)


def _get(url: str) -> tuple[int, bytes, dict]:
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read(), dict(resp.headers)
    except urllib.error.HTTPError as err:
        return err.code, err.read(), dict(err.headers)


def _get_json(url: str) -> tuple[int, object]:
    status, body, _ = _get(url)
    return status, json.loads(body)


def _post_multipart(
    url: str, fields: dict[str, str], files: dict[str, tuple[str, bytes]]
) -> tuple[int, object]:
    boundary = "----audit-api-test-boundary"
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.append(
            (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'
                f"{value}\r\n"
            ).encode()
        )
    for name, (filename, data) in files.items():
        chunks.append(
            (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
                f"Content-Type: text/csv\r\n\r\n"
            ).encode()
            + data
            + b"\r\n"
        )
    chunks.append(f"--{boundary}--\r\n".encode())
    body = b"".join(chunks)
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as err:
        raw = err.read()
        try:
            return err.code, json.loads(raw)
        except ValueError:
            return err.code, raw.decode(errors="replace")


def _make_sales_csv() -> bytes:
    """~20 weeks of daily sales for 2 SKUs (small but Phase-0-viable)."""
    rows = ["date,sku,location,qty,unit_price"]
    start = date(2024, 1, 1)
    for offset in range(140):
        day = (start + timedelta(days=offset)).isoformat()
        rows.append(f"{day},SKU_A,ALL,3,10.00")
        rows.append(f"{day},SKU_B,ALL,2,5.00")
    return ("\n".join(rows) + "\n").encode()


# ---------------------------------------------------------------------------
# tests
# ---------------------------------------------------------------------------

def test_health(base_url):
    status, body = _get_json(f"{base_url}/api/health")
    assert status == 200
    assert body == {"status": "ok"}


def test_run_lifecycle(base_url):
    status, body = _post_multipart(
        f"{base_url}/api/runs",
        fields={"client": TEST_CLIENT_NAME, "with_models": "false"},
        files={"sales": ("sales.csv", _make_sales_csv())},
    )
    assert status == 202, body
    assert body["client"] == TEST_CLIENT_NAME
    assert body["status"] == "running"
    run_id = body["run_id"]
    assert run_id

    # poll status until terminal (~120s budget)
    deadline = time.time() + 120
    status_body = None
    while time.time() < deadline:
        code, status_body = _get_json(f"{base_url}/api/runs/{TEST_CLIENT_NAME}/{run_id}")
        assert code == 200, status_body
        if status_body["status"] in TERMINAL:
            break
        time.sleep(2)

    assert status_body is not None
    # a tiny file may legitimately halt at Phase 0; assert terminal, not success
    assert status_body["status"] in TERMINAL, f"run not terminal: {status_body}"
    if status_body["status"] == "failed":
        pytest.fail(f"run failed: {status_body['error']}")

    if status_body["status"] == "complete":
        summary = status_body["summary"]
        assert summary is not None
        for key in (
            "lost_units_low", "lost_units_high", "lost_revenue_low", "lost_revenue_high",
            "episodes", "dead_stock_value", "overstock_value", "total_stock_value",
            "n_skus", "routing_tier",
        ):
            assert key in summary
        assert summary["n_skus"] == 2
        assert status_body["manifest"] is not None
        assert status_body["error"] is None

        code, _, headers = _get(f"{base_url}/api/runs/{TEST_CLIENT_NAME}/{run_id}/report")
        assert code == 200
        assert "text/html" in headers.get("content-type", "")
        code, _, _ = _get(f"{base_url}/api/runs/{TEST_CLIENT_NAME}/{run_id}/workbook")
        assert code == 200
        code, _, headers = _get(f"{base_url}/api/runs/{TEST_CLIENT_NAME}/{run_id}/health-md")
        assert code == 200
        assert "text/markdown" in headers.get("content-type", "")

    # run shows up in the listing
    code, listing = _get_json(f"{base_url}/api/runs")
    assert code == 200
    entries = [e for e in listing if e["client"] == TEST_CLIENT_NAME and e["run_id"] == run_id]
    assert len(entries) == 1
    entry = entries[0]
    assert set(entry) == {"client", "run_id", "status", "created", "has_report"}
    assert entry["status"] in TERMINAL


def test_models_catalog(base_url):
    status, body = _get_json(f"{base_url}/api/models")
    assert status == 200
    assert isinstance(body, dict)
    models = body["models"]
    defaults = body["defaults"]
    assert isinstance(models, list)
    assert len(models) >= 43
    required = {"id", "name", "family", "intermittent", "default", "blurb"}
    for m in models:
        assert required <= set(m), f"missing keys on {m}"
    assert isinstance(defaults, list)
    assert len(defaults) > 0
    known_ids = {m["id"] for m in models}
    assert set(defaults) <= known_ids


def test_run_with_model_selection(base_url):
    status, body = _post_multipart(
        f"{base_url}/api/runs",
        fields={
            "client": TEST_CLIENT_NAME,
            "with_models": "true",
            "models": "M5,M9",
            "combos": "CC02",
        },
        files={"sales": ("sales.csv", _make_sales_csv())},
    )
    assert status == 202, body
    run_id = body["run_id"]
    assert run_id

    deadline = time.time() + 120
    status_body = None
    while time.time() < deadline:
        code, status_body = _get_json(f"{base_url}/api/runs/{TEST_CLIENT_NAME}/{run_id}")
        assert code == 200, status_body
        if status_body["status"] in TERMINAL:
            break
        time.sleep(2)

    assert status_body is not None
    assert status_body["status"] in TERMINAL, f"run not terminal: {status_body}"
    if status_body["status"] == "failed":
        pytest.fail(f"run failed: {status_body['error']}")

    # a tiny-file run may halt at Phase 0; the selection is only recorded in
    # summary.json on a complete run. Assert it there when available.
    if status_body["status"] == "complete":
        summary = status_body["summary"]
        assert summary is not None
        assert summary.get("selected_models") == ["M5", "M9"]
        assert summary.get("selected_combos") == ["CC02"]


def test_missing_run_404(base_url):
    code, _, _ = _get(f"{base_url}/api/runs/nosuchclient/nosuchrun")
    assert code == 404
    code, _, _ = _get(f"{base_url}/api/runs/nosuchclient/nosuchrun/report")
    assert code == 404


def test_path_traversal_rejected(base_url):
    # encoded dot segments reach the route params without URL normalization
    for path in (
        "/api/runs/%2e%2e/%2e%2e",
        "/api/runs/%2e%2e/x",
        "/api/runs/..%2f..%2fconfig/defaults.yaml",
        "/api/runs/%2e%2e/%2e%2e/report",
        "/api/runs/..../....",  # dots-only segments are rejected outright
    ):
        code, _, _ = _get(f"{base_url}{path}")
        assert code in (400, 404), f"{path} -> {code}"

    # the path helper itself rejects literal traversal segments
    with pytest.raises(Exception):
        api._run_dir("..", "whatever")
    with pytest.raises(Exception):
        api._run_dir("client", "..")


def test_client_name_sanitized():
    assert api._sanitize_client("../Evil Client!") == "evil-client"
    assert api._sanitize_client("") == "client"
    assert api._sanitize_client("..") == "client"
    assert api._sanitize_client("Demo_1") == "demo_1"
