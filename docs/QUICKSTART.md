# Quickstart — run it locally

Works on Windows, macOS, and Linux. Prerequisites: **Node 20+**, **npm**, and **Docker Desktop**
(running).

## One command

```bash
git clone <repo> && cd Restock-Multitenant
npm run setup
```

`npm run setup` installs dependencies, starts Postgres + Redis in Docker, creates the local env
files, applies migrations (which also create the restricted DB roles and Row-Level Security),
generates the Prisma client, and loads demo data (tenant `amara-beauty`, ~30 SKUs, 90 days of sales).
It's idempotent — safe to re-run.

Then:

```bash
npm run dev          # the web app on http://localhost:3000
npm run -w @wezesha/worker dev   # (optional) crons + sync; needs Redis
```

Sign in with the seeded owner: **`dev@wezesha.test` / `Dev12345!`**.

## What the app talks to

| Service | Where | Port |
|---|---|---|
| Postgres | Docker (`docker compose up -d db`) | 5434 |
| Redis | Docker (`docker compose up -d redis`) | 6380 |
| Web (Next.js) | `npm run -w web dev` | 3000 |
| Worker (BullMQ crons + Shopify sync) | `npm run -w @wezesha/worker dev` | — |

> If auth rejects with "Invalid origin", the serving port must match `BETTER_AUTH_URL` in
> `apps/web/.env.local`. Serve on that port, or set `BETTER_AUTH_URL` to your port.

## Handy scripts

| Command | Does |
|---|---|
| `npm run setup` | Full local bootstrap (above) |
| `npm run db:up` / `npm run db:down` | Start / stop Postgres + Redis |
| `npm run migrate` | Apply DB migrations |
| `npm run seed` | Reload the demo tenant (rebuilds it each run) |

## Manual setup (if you don't want the one command)

1. `npm install`
2. `docker compose up -d db redis`
3. `cp packages/db/.env.example packages/db/.env` (defaults point at localhost:5434)
4. `cp apps/web/.env.example apps/web/.env.local` (fill secrets)
5. `npm run -w @wezesha/db db:migrate:deploy`
6. `npm run -w @wezesha/db db:generate`
7. `npm run seed`
8. `npm run dev`

## Tests

```bash
npm run -w @wezesha/db test        # includes the tenant-isolation + RLS-coverage suites (need Postgres)
npm run -w web test                # includes money-blind / member-visibility (needs Postgres)
npm run -w @wezesha/forecast test  # pure unit
```

The DB-backed suites need Docker Postgres up (`npm run db:up`). Worker cron tests additionally need
`REDIS_URL` + `SERVICE_DATABASE_URL` exported, or they skip. See `docs/ARCHITECTURE.md` for the full
picture, the branch model, and the current feature/route map.
