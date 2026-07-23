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
- `packages/realtime` — typed realtime event contract and the Redis publish
  helper
- `packages/queue` — BullMQ sync queue: deterministic job ids + the no-overlap
  enqueue guard (shared by web and worker)
- `packages/shopify` — Shopify Admin API core: OAuth + HMAC verification, typed
  GraphQL client with rate-limit handling, id/sales mappers, token crypto
- `apps/forecast` — Python forecasting sidecar (planned)

## Development

- Node 22+, npm workspaces: `npm install` from the root.
- Local services: `docker compose up -d db redis` (ports 5434/6380).
- Each app documents its own setup in its README.
- Branching: feature/fix branches merge into `develop` for testing;
  `develop` promotes to `main`.

## Deployment

- `deploy/RUNBOOK.md` — ordered first-deploy checklist (Supabase, Railway, Vercel).
- `deploy/ENVIRONMENT.md` — every environment variable, per service and platform.
