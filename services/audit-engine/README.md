# Inventory Audit Engine

Diagnostic engine for retail inventory: takes a client's transaction-level **sales CSV** plus a **current stock export** and produces a paid-audit deliverable — lost sales from inferred stockouts, dead stock, overstock, data-quality findings, and an evidence-based forecasting-model recommendation. It is an audit tool, not an ordering system (that's v2 — see `SPEC.md` §20).

## How it works

1. **Phase 0 health audit** — go/no-go gates on history depth, zero-vs-null ambiguity, price availability (`SPEC.md` §3). A no-go halts with a data remediation report.
2. **17-step preprocessing chain** — dedupe, return netting, bulk-order exclusion, promo retro-detection, availability correction, trailing-window winsorization; every mutation writes to an audit log (§4).
3. **Stockout inference** — Poisson zero-run detection with a cross-sectional closure check and confidence tiers (§5). The headline finding: "you were out of stock N days and it cost you roughly £X–£Y."
4. **Findings** — lost sales (as ranges), repeat offenders, dead stock, weeks-of-cover, ABC concentration, forecastability split (§7).
5. **Model selection harness** — 12 models + combinations scored in a nested rolling-origin backtest (selection block picks champions, a touch-once validation block measures the winner's curse) producing a provisional routing table (§8–10).
6. **Report** — self-contained HTML + Excel SKU-detail workbook, with a mandatory "What we could not see" limitations section (§11–12).

## Quickstart (CLI)

```bash
uv sync --group dev
uv run pytest -q                          # full test suite
uv run audit synth --scenario full --out data/synth      # synthetic demo data
uv run audit health data/synth/sales.csv --stock data/synth/stock.csv
uv run audit run data/synth/sales.csv --stock data/synth/stock.csv --client demo
# -> runs/demo/<run_id>/report/report.html + sku_detail.xlsx
```

## Web service + frontend

- **API** — FastAPI (`src/audit_engine/api.py`): `uv run uvicorn audit_engine.api:app --port 8000`. Upload CSVs, poll status, fetch report/workbook. Deployed via the root `Dockerfile` (Railway-ready, `railway.toml`).
- **Frontend** — Next.js app in `frontend/`: upload UI, run tracking, summary dashboard, report viewer. `cd frontend && npm install && npm run dev`. Deploys to Vercel (root directory `frontend`, env `NEXT_PUBLIC_API_URL` → the API URL).

## How forecasts are tested

The engine never scores a model on data it learned from. It **walks forward**:
stand at a past cutoff, show each model only earlier weeks, predict the next 4,
compare to what actually sold, slide the cutoff forward, repeat — across ~16
cutoffs, split into a selection block (picks champions) and a touch-once
validation block (the honest number). Bias is weighted as heavily as WAPE,
because on a mostly-zero catalogue you "win" accuracy by under-forecasting.
Full methodology: **[docs/FORWARD_TESTING.md](docs/FORWARD_TESTING.md)**.

## Repo map

Engine spec: `SPEC.md`. Forward-testing method: `docs/FORWARD_TESTING.md`. Module API contracts: `CONTRACTS.md`. Config thresholds: `config/defaults.yaml` (client overrides in `config/clients/`). Engine code: `src/audit_engine/` (ingest → clean → availability → baseline → models → selection → findings → report; synthetic generator with planted faults in `synth/`). Tests: `tests/` (unit, hypothesis property tests, fixtures).
