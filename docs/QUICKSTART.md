# Quickstart — run it locally

Works on Windows, macOS, and Linux. Prerequisites: **Node 22** (what CI and the Docker images
run), **npm**, and **Docker Desktop** (running).

> **On WSL (Ubuntu):** also enable Docker Desktop → **Settings → Resources → WSL Integration** →
> toggle your distro **on** → *Apply & Restart* (otherwise `docker` isn't available inside the distro).
> Install Node 22 in the distro if missing (`curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`).

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

Seeded sign-ins (same shop, three roles): **owner** `owner@wezesha.test` / `Owner12345!` · **admin**
`admin@wezesha.test` / `Admin12345!` · **member/staff** `staff@wezesha.test` / `Staff12345!`
(money-blind). See `docs/QA-TESTPLAN.md`.

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

To exercise `POST /api/pos/ingest` locally, issue that tenant a secret first — the seed
doesn't, and a tenant without one is closed (every call answers 401):

```bash
cd packages/pos && npx tsx scripts/provision-ingest-secret.ts amara-beauty
```

It prints the secret once (only the hash is stored) and the POS bridge sends it as
`Authorization: Bearer <secret>`. Re-running rotates it and kills the old one; so does
`npm run seed`, which rebuilds the demo tenant from scratch.

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
