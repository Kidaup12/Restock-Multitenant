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

## Connecting a real Shopify store

Not locally — Shopify needs a public address to send the install back to, which a machine on
localhost doesn't have. Connect a store on the deployed app instead. You can create your own free
development store rather than borrowing anyone's: see `docs/SHOPIFY-DEV-STORE.md`.

Locally, email doesn't leave the machine unless `RESEND_API_KEY` and `EMAIL_FROM` are set — invites,
sign-in codes and supplier purchase orders are written to the terminal running the app, so a fresh
clone is still testable end to end. The link you need is in that terminal.

> **After a new version deploys, open a fresh tab.** A tab left open across a deploy posts to a
> server action that no longer exists and gets a 404 that looks exactly like a broken feature.

## Handy scripts

| Command | Does |
|---|---|
| `npm run setup` | Full local bootstrap (above) |
| `npm run db:up` / `npm run db:down` | Start / stop Postgres + Redis |
| `npm run migrate` | Apply DB migrations |
| `npm run seed` | Reload the demo tenant (rebuilds it each run) |

## A store big enough to judge the forecast

`npm run seed` gives you ~30 products and 90 days of sales — enough to click around, not
enough to tell whether a run rate is right. For that there's a generator that builds a
400-SKU catalogue and 15 months of trading:

```bash
cd packages/shopify && node --env-file=../db/.env --import tsx scripts/seed-sales-history-direct.ts --tenant amara-beauty --dry-run
```

`--dry-run` prints what it would create — SKU count, sales rows, the ABC split, how much
is dead, out of stock or missing a cost — so you can see the shape before writing
anything. Drop the flag to apply, then run the forecast from Today.

The history it writes has weekday and seasonal patterns, promotions, stockout gaps, dead
stock, brand-new products and some that have never sold, because those are the shapes the
forecast is supposed to react to. It writes on the `seed` channel, so removing it is one
delete on that channel and nothing else is touched. It refuses to run against a workspace
with a live Shopify connection unless you pass `--force`.

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
