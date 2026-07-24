# Architecture & repo guide

Wezesha Restock is a multi-tenant SaaS that tells a shop **what to reorder, how much, and when** —
and tracks the two numbers a shop owner cares about: **stockout rate** and **dead stock**. This is
the guide for reviewing and running the repo.

## Monorepo layout (npm workspaces)

```
apps/
  web/         Next.js (App Router) — all screens + server actions + API routes
  worker/      BullMQ worker — nightly crons (forecast, cost-moved, POS gap, limits) + Shopify sync
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
  worker runs it nightly (`FORECAST_CRON`) and writes `Prediction` rows.
- **The worker** also runs cost-moved detection (`COST_CRONS`), POS sales-gap detection, and plan-limit
  checks, and performs Shopify OAuth sync. Realtime events flow web ⇄ ws-gateway ⇄ worker via Redis.

## Multi-tenant isolation (security)

- **Postgres Row-Level Security is the enforcement**, not just app code. Every tenant-owned table
  (29 of them) has RLS enabled with a fail-closed policy
  (`USING tenantId = current_setting('app.tenant_id')`).
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

`feature/*` → **`develop`** (integration) → a **testing branch** (QA on a production-like deploy) →
**`main`** (go-live). Commits are atomic and conventional (`feat`/`fix`/`refactor`/`chore`/`docs`/
`test`). Test on production-like infra, not just local. Deploy targets: **Vercel** (web), **Supabase**
(Postgres), **Railway** (worker + Redis); Dockerfiles + `docker-compose.staging.yml` for rehearsal.
See `deploy/RUNBOOK.md` + `deploy/ENVIRONMENT.md`.

## Testing / QA

~96 vitest suites (unit + integration). DB-backed suites (`packages/db`, parts of `web`) need Docker
Postgres up; worker cron tests need `REDIS_URL` + `SERVICE_DATABASE_URL` exported or they skip.
Security-critical suites to run first: `packages/db` (isolation + RLS) and `web` money-blind
(`member-visibility`, `orders-money-blind`). **There are no end-to-end/UI tests yet** — nav or
render regressions aren't caught by the current suites.

## Feature / route map — what's surfaced vs deferred

| Area | Route(s) | State |
|---|---|---|
| Today (money picture, reorder list) | `/today` | Surfaced |
| Restock plan / buy list | `/plan` | Surfaced (depth in progress — see below) |
| Orders & receiving | `/orders`, `/orders/[id]` | Surfaced |
| Stock catalogue + money band | `/stock` | Surfaced |
| Costs & coverage (money-blind) | `/costs` | Surfaced |
| Suppliers & lead times | `/suppliers` | Surfaced (in nav) |
| Sales / POS reconciliation | `/sales` | Surfaced |
| Connections (Shopify/QB/POS) | `/settings/connections` | Surfaced (from Settings) |
| Locations & roles, Team | `/settings/locations`, `/settings/team` | Surfaced |
| Insights (proof/accuracy) | `/insights` | **Placeholder — deferred** |
| Forecast trust surfaces (confidence render, cold-start queue, "tell the forecast", receipts, what-changed) | — | **Built + tested in the engine; UI deferred** |

## Known gaps / in progress (be honest with reviewers)

- **Forecast intelligence is engine-only.** Confidence words, cold-start, backtest, and the owner
  "tell the forecast" priors are coded + unit-tested but not yet rendered. Insights is a placeholder.
- **Planner depth.** `/plan` works (checklist + budget modes, per-line "why", CSV/PDF, money-blind)
  but the richer buy-list from the reference build is in progress — cover-horizon sizing, scope
  filters, exclude-already-ordered + double-order warnings, MOQ rounding, supplier-grouped draft POs,
  sales-target mode, a supply calendar. See `.claude`-tracked planner target.
- **Signals (promo / closure normalization).** Stockout gaps are removed from the run-rate; **past
  promo spikes and shop-closure days are not yet excluded**, and there's no UI yet for an owner to
  declare a promo/closure. Late/backdated data does reconcile (date-keyed history + re-run).
- **No end-to-end tests** and **no ML backtest sidecar** (the engine is pure TypeScript).
