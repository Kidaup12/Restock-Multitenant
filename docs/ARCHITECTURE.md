# Architecture & repo guide

Wezesha Restock is a multi-tenant SaaS that tells a shop **what to reorder, how much, and when** —
and tracks the two numbers a shop owner cares about: **stockout rate** and **dead stock**. This is
the guide for reviewing and running the repo.

## Monorepo layout (npm workspaces)

```
apps/
  web/         Next.js (App Router) — all screens + server actions + API routes
  worker/      BullMQ worker — nightly crons (forecast, snapshot, cost-moved, POS gap, limits, email) + Shopify sync
  ws-gateway/  WebSocket gateway for realtime updates
packages/
  db/          Prisma schema + client, the tenant-scoped resolver, RLS roles/policies, seed
  forecast/    the demand engine (run-rate, ABC, cover, safety stock, confidence, cold-start, backtest)
  forecast-run/ orchestrates a forecast/backtest run so the worker can invoke the engine
  pos/         point-of-sale ingest (unmatched-SKU queue, gap detection)
  shopify/     Shopify Admin API client + sync
  realtime/    event publish/subscribe helpers
  queue/       BullMQ helpers
  observability/ logging + error capture
```

## How it interconnects (data flow)

```
Shopify orders ─┐
                ├─► SalesHistory (one table, per channel)  ─► forecast engine ─► Predictions
in-store POS ───┘        (Product.currentStock = on-hand)        │                    │
                                                                 ▼                    ▼
                                          metrics contract (lib/metrics/calc.ts) ─► screens:
                                          run-rate · ABC · cover · revenue ·        Today, Plan,
                                          money-at-rest — computed ONCE             Stock, Costs, Sales
```

- **Sales in, one history.** Shopify sync (worker) and POS ingest both write `SalesHistory`
  keyed by `(productId, date, channel)`. Late/backdated entries land on their real date and are
  reconciled on the next forecast run (nightly, or on-demand via the **Run forecast** button).
- **One metrics contract.** `apps/web/lib/metrics/calc.ts` defines run-rate, cover, and ABC **once**;
  every screen imports it (a CI test asserts Today/Stock/Plan/Sales agree). `Product.currentStock` is
  the single on-hand source.
- **The engine** (`packages/forecast`) turns history into a per-product recommended quantity with an
  explain breakdown and a plain-language confidence word (`sure` / `fairly sure` / `guessing`). The
  worker runs it at 02:00 daily and writes `Prediction` rows — replaced wholesale each run — plus an
  append-only `ForecastRecommendation` row per keepable ask, which is what plan-adherence over past
  weeks is measured from.
- **The worker** also runs cost-moved detection, POS sales-gap detection, plan-limit checks and the
  weekly summary email, and performs Shopify OAuth sync. Realtime events flow web ⇄ ws-gateway ⇄
  worker via Redis.
- **On-hand history.** A nightly snapshot (01:00, ahead of the forecast) writes one
  `InventorySnapshot` row per active product per UTC day from `Product.currentStock`, pruned to ~400
  days. Stockout rate and dead stock week over week are read off it; nothing else records on-hand
  over time, so it has to be running before those trends can exist.
- **Every cron group is off unless switched on.** `FORECAST_CRON`, `COST_CRONS`, `POS_CRONS`,
  `OPS_CRONS`, `EMAIL_CRONS` and `SNAPSHOT_CRON` each register their schedules only when set to `1`
  (`apps/worker/src/index.ts`), so dev and CI stay quiet — a deployed environment that wants the
  nightly forecast has to set `FORECAST_CRON=1`. Until then the **Run forecast** button is the only
  thing that produces predictions. See `deploy/ENVIRONMENT.md`.

## Multi-tenant isolation (security)

- **Postgres Row-Level Security is the enforcement**, not just app code. Every table carrying a
  `tenantId` has RLS enabled with a fail-closed policy
  (`USING tenantId = current_setting('app.tenant_id')`). The count isn't tracked by hand — the
  coverage census enumerates the live schema and fails CI on any table that ships without a policy.
- The app connects as a **restricted role** (`wezesha_app`, no BYPASSRLS). All tenant data goes
  through one sanctioned resolver, `prismaForTenant(tenantId)` (`packages/db/src/client.ts`), which
  sets the tenant GUC transaction-locally. Tenant is resolved **server-side from session → membership**,
  never from the URL.
- A privileged role (`wezesha_service`, BYPASSRLS) is used only for system paths (audit log,
  auth/webhook/sync bootstrap, admin-gated cross-tenant ops).
- Proven by `packages/db/tests/{tenant-isolation,rls-coverage}.test.ts` (run against real Postgres):
  cross-tenant read/update/delete = 0, insert rejected, coverage enumerated dynamically.
- **New tenant table checklist:** add the RLS policy + a coverage test row in the same change
  (`packages/db/README.md`).

## Money-blind (staff can't see costs)

Cost/margin figures are redacted at the **data layer** — getters take `canViewCosts` (from
`hasPermission(membership, "view_costs")`) and return `null` for KES cost fields, so a member's
payload never carries the numbers. `CostValue` masks any null amount. Covered by
`apps/web/tests/member-visibility.test.tsx` (walks serialized payloads) and `orders-money-blind.test.ts`.
The supplier PO email carries cost by design (it goes to the supplier).

## Branch model & workflow

`feature/*` (and `fix/*`, `chore/*`, `docs/*`) → **`develop`** (integration, merged `--no-ff`) →
**`main`** (go-live). Those two are the only long-lived branches on the remote. QA happens on the
`develop` deploy, which Vercel publishes as a Preview — `main` is the Production Branch. Commits are
atomic and conventional (`feat`/`fix`/`refactor`/`chore`/`docs`/`test`). Test on production-like
infra, not just local. Deploy targets: **Vercel** (web), **Supabase** (Postgres), **Railway**
(worker + ws-gateway + Redis); Dockerfiles + `docker-compose.staging.yml` for rehearsal. See
`deploy/RUNBOOK.md` + `deploy/ENVIRONMENT.md`.

## Testing / QA

Vitest throughout, unit and integration. DB-backed suites (`packages/db`, parts of `web` and
`worker`) need Docker Postgres up; worker cron tests need `REDIS_URL` + `SERVICE_DATABASE_URL`
exported or they skip locally. In CI that skip is a hard failure instead — a suite that asserts
nothing must not report green (`scripts/test-infra-guard.ts`). CI (`.github/workflows/ci.yml`) runs
nine jobs on Node 22: `db`, `web-tests`, `worker-tests`, `package-tests-db`,
`package-tests-redis`, `lint`, `web-build` (typecheck + `next build`), `services-typecheck`, and
`docker-build` (all three images).
Security-critical suites to run first: `packages/db` (isolation + RLS) and `web` money-blind
(`member-visibility`, `orders-money-blind`). **There are no end-to-end/UI tests yet** — nav or
render regressions aren't caught by the current suites.

## Feature / route map — what's surfaced vs deferred

| Area | Route(s) | State |
|---|---|---|
| Today (money picture, reorder list) | `/today` | Surfaced |
| Restock plan / buy list — checklist, budget allocator, supply calendar | `/plan` | Surfaced |
| Orders & receiving | `/orders`, `/orders/[id]` | Surfaced |
| Stock catalogue + money band | `/stock` | Surfaced |
| Costs & coverage (money-blind) | `/costs` | Surfaced |
| Suppliers & lead times | `/suppliers` | Surfaced (in nav) |
| Sales / POS reconciliation | `/sales` | Surfaced |
| Connections (Shopify/QB/POS) | `/settings/connections` | Surfaced (from Settings) |
| Locations & roles, Team | `/settings/locations`, `/settings/team` | Surfaced |
| Own profile; mobile nav overflow | `/profile`, `/more` | Surfaced |
| Cross-tenant operator console (audit log, per-tenant view) | `/admin`, `/admin/audit`, `/admin/tenant/[id]` | Surfaced, but 404s unless the account holds a live `PlatformAdmin` row (or, while that table is empty, is in `ADMIN_EMAILS`) |
| Insights (proof/accuracy) | `/insights` | **Placeholder — deferred** |
| Forecast trust surfaces (confidence render, cold-start queue, "tell the forecast", receipts, what-changed) | — | **Built + tested in the engine; UI deferred** |

## Known gaps / in progress (be honest with reviewers)

- **Forecast intelligence is engine-only.** Confidence words, cold-start, backtest, and the owner
  "tell the forecast" priors are coded + unit-tested but not yet rendered. Insights is a placeholder.
- **Planner depth.** `/plan` works (checklist + budget modes, per-line "why", CSV/PDF, money-blind)
  but the richer buy-list from the reference build is in progress — cover-horizon sizing, scope
  filters, exclude-already-ordered + double-order warnings, MOQ rounding, supplier-grouped draft POs,
  sales-target mode, a supply calendar.
- **Signals (promo / closure normalization).** Stockout gaps are removed from the run-rate; **past
  promo spikes and shop-closure days are not yet excluded**, and there's no UI yet for an owner to
  declare a promo/closure. Late/backdated data does reconcile (date-keyed history + re-run).
- **No end-to-end tests** and **no ML backtest sidecar** (the engine is pure TypeScript).
