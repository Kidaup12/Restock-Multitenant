# Wezesha Restock OS

Multi-tenant stock-replenishment platform for Shopify retailers: demand
forecasting, reorder recommendations, and the purchase-order workflow, with
per-tenant data isolation enforced at the database.

## Layout

- `apps/web` — the Next.js application (frontend + API routes); PWA shell
- `apps/ws-gateway` — standalone WebSocket gateway: Redis pub/sub in,
  tenant-scoped sockets out
- `apps/worker` — background job runner: BullMQ queues with per-tenant
  no-overlap guards
- `packages/db` — Prisma schema, migrations, and the tenant-scoped database
  clients (RLS enforcement)
- `packages/forecast` — the demand engine: run-rate, ABC, cover, safety stock,
  confidence, cold start, backtest
- `packages/forecast-run` — orchestrates a forecast or backtest run so the
  worker can invoke the engine
- `packages/pos` — point-of-sale ingest: per-tenant feed auth, unmatched-SKU
  queue, sales-gap detection
- `packages/realtime` — typed realtime event contract and the Redis publish
  helper
- `packages/queue` — BullMQ sync queue: deterministic job ids + the no-overlap
  enqueue guard (shared by web and worker)
- `packages/shopify` — Shopify Admin API core: OAuth + HMAC verification, typed
  GraphQL client with rate-limit handling, id/sales mappers, token crypto
- `packages/observability` — logging and error capture, shared by all three apps

## Development

- Node 22 (what CI and the Docker images run), npm workspaces: `npm install` from
  the root. Full local bootstrap in one command: `npm run setup` — see
  `docs/QUICKSTART.md`.
- Local services: `docker compose up -d db redis` (ports 5434/6380).
- Each app documents its own setup in its README.
- Branching: `feature/*` (and `fix/*`, `chore/*`, `docs/*`) merge into `develop`
  with `--no-ff`; `develop` promotes to `main`. Those two are the only long-lived
  branches.

## Deployment

- `deploy/RUNBOOK.md` — ordered first-deploy checklist (Supabase, Railway, Vercel).
- `deploy/ENVIRONMENT.md` — every environment variable, per service and platform.
- `docs/ARCHITECTURE.md` — how the pieces interconnect, isolation model, route map.
