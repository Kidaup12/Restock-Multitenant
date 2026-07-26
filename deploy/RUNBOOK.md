# First-deploy runbook

Ordered checklist for standing up production: Supabase (Postgres) → Railway
(Redis + ws-gateway + worker) → Vercel (web). Every step is either a console click
path or an exact command. Prerequisites: repo access, a Supabase org, a Railway
account, a Vercel account, a secrets vault, and locally `node` 22 + `npm` + `psql`.

Environment variables are catalogued in `deploy/ENVIRONMENT.md` — this file only says
*when* to set them.

---

## 0. Decisions baked into this setup

- **Services run via tsx with node_modules, not as esbuild bundles.** Both service
  images (`apps/worker/Dockerfile`, `apps/ws-gateway/Dockerfile`) install the pruned
  workspace subtree (`npm ci -w <service>`), generate the Prisma client, and run
  `src/index.ts` with tsx as the non-root `node` user. The original plan (bundle
  `src/index.ts` into one `dist/index.cjs`, ship no node_modules) died when both
  services gained `@wezesha/db`: the Prisma query engine is a native binary resolved
  relative to the generated client directory, which a single-file bundle cannot
  carry. The gateway's `npm run build` esbuild script remains for local
  experiments, but the images do not use it. tsx is a production dependency of both
  services; esbuild/tsx do not typecheck — CI's `services-typecheck` job holds that
  line.
- **Docker build context is the repo root** (both Dockerfiles start
  `docker build -f apps/<svc>/Dockerfile .`) so the lockfile and workspace graph are
  visible; `npm ci -w <service>` prunes the install to that service's subtree.
- **Railway config-as-code** is per-service `railway.json` (`apps/ws-gateway/railway.json`,
  `apps/worker/railway.json`): Dockerfile builder + on-failure restart policy. Each
  Railway service points at the same repo with its own **Config File Path** (step 4).
  Root Directory stays the repo root — do not set it per service, or the Docker build
  context loses the workspace graph.
- **Gateway health check is `GET /healthz`** on the ws port (200 with
  `{uptime, connections}`). The Dockerfile HEALTHCHECK probes it for docker-level
  supervision; set Railway's HTTP health check path to `/healthz` for the gateway
  service.

## Local staging rehearsal (before deploy day)

The whole prototype topology runs locally under compose, mirroring the prod split
(db, redis, ws-gateway, worker, web as separate services networked by name). Run
this rehearsal before touching any cloud console — it proves the images, the env
contract, and the event pipeline with zero accounts.

Boot (one command after the env copy; `--build` rebuilds the three app images):

```sh
cp .env.staging.example .env.staging   # adjust host ports if other stacks hold the defaults
docker compose --env-file .env.staging \
  -f docker-compose.yml -f docker-compose.staging.yml up -d --build
```

Verify (substitute the ports from your `.env.staging`):

```sh
docker compose --env-file .env.staging \
  -f docker-compose.yml -f docker-compose.staging.yml ps    # five services, gateway/web healthy

curl -sS http://localhost:${WS_GATEWAY_PORT}/healthz        # {"uptime":...,"connections":...}
curl -sSI http://localhost:${WEB_PORT}/today | head -1      # 200, or 307 to /login

# fail-closed auth: a bogus credential must close with 4401
npx wscat -c "ws://localhost:${WS_GATEWAY_PORT}/?token=definitely-not-a-session"

# queue -> worker leg (no socket): enqueues one demo job, worker logs it completed
REDIS_URL=redis://localhost:${REDIS_PORT} npx tsx deploy/scripts/smoke-enqueue.ts
```

**The socket leg under compose needs a real session.** The gateway image runs with
`NODE_ENV=production` (`apps/ws-gateway/Dockerfile`), and the gateway ignores
`WS_DEV_TOKEN` under that setting — so the smoke script's `WS_URL`/`WS_TOKEN`
round-trip does *not* work against the composed gateway, even though `.env.staging`
carries a dev token. Exercise the socket end-to-end either by signing in to the web
service at `http://localhost:${WEB_PORT}` and watching a sync update the page live, or
by running the gateway outside the image (`npm run -w @wezesha/ws-gateway dev`, which
leaves `NODE_ENV` unset) and pointing the script at it.

Tear down:

```sh
docker compose --env-file .env.staging \
  -f docker-compose.yml -f docker-compose.staging.yml down
# add -v to also drop the db/redis volumes
```

Notes: the base `docker-compose.yml` stays the lightweight dev-infra stack
(`docker compose up -d db redis`); staging is an explicit opt-in via the second
`-f`. The web image uses Next standalone output, gated behind `NEXT_OUTPUT` in
`next.config.ts` so host builds are unaffected. Production web still deploys to
Vercel — the web container exists for this rehearsal and any future self-hosted
fallback.

## 1. Supabase — project + backups

1. Console: **New project** → org, name (e.g. `wezesha-restock-prod`), strong database
   password (generate → vault), region closest to users (Nairobi → `eu-central-1`
   unless an African region is offered). Wait for provisioning.
2. **Enable backups NOW, before any data exists:**
   - Plan must be Pro or above for point-in-time recovery. Console → Project →
     Database → Backups → enable **PITR** (choose retention, 7 days minimum).
   - If PITR is not available on the current plan, confirm daily scheduled backups
     are on (they are by default on paid plans) and record the schedule here.
3. Record from Console → Project Settings → General / Connect:
   - project ref (`<project-ref>`)
   - pooler host (`aws-0-<region>.pooler.supabase.com`)
   - direct host (`db.<project-ref>.supabase.co`)

## 2. Roles — run prod-roles.sql as postgres (before any migrate)

The first migration creates `wezesha_app` / `wezesha_service` with **dev passwords**
if they don't exist. Pre-creating them with real credentials makes those guards
skip, so dev passwords never reach production. Order matters: roles first, migrate
second.

1. Generate two strong passwords → vault (`app-role-password`, `service-role-password`).
2. Open `packages/db/prisma/sql/prod-roles.sql`, copy its two statements into the
   Supabase **SQL Editor** (runs as `postgres`, which carries the needed grants),
   replace the placeholders with the vault values, run. Do not save the real values
   anywhere but the vault; do not edit the file in the repo.
3. Verify:
   ```sql
   SELECT rolname, rolcanlogin, rolbypassrls FROM pg_roles
    WHERE rolname LIKE 'wezesha_%';
   ```
   Expect `wezesha_app` (login, no bypass) and `wezesha_service` (login, bypassrls).

## 3. Migrate + verify RLS

1. Compose the three URLs per `deploy/ENVIRONMENT.md` (pooled `:6543` with
   `pgbouncer=true&connection_limit=1` for app/service, direct `:5432` for owner) →
   vault.
2. From a repo checkout, in a shell with **only this project's env** (do not reuse a
   dev shell with a local `.env` loaded):
   ```sh
   export DATABASE_URL='<pooled wezesha_app url>'
   export DIRECT_URL='<direct owner url>'
   npm ci
   npm run -w @wezesha/db db:generate
   npm run -w @wezesha/db db:migrate:deploy
   ```
   `migrate deploy` uses `DIRECT_URL`; `DATABASE_URL` must merely be set for schema
   validation.
3. **RLS census, manually, against prod** (the same invariant the CI suite enforces —
   every table with `tenantId` must have RLS enabled and a two-sided policy):
   ```sh
   psql '<direct owner url>' -c "
   SELECT t.tablename,
          t.rowsecurity,
          p.policyname,
          (p.qual IS NOT NULL)       AS has_using,
          (p.with_check IS NOT NULL) AS has_with_check
     FROM pg_tables t
     LEFT JOIN pg_policies p
       ON p.schemaname = t.schemaname AND p.tablename = t.tablename
      AND p.policyname = 'tenant_isolation'
    WHERE t.schemaname = 'public'
      AND EXISTS (SELECT 1 FROM information_schema.columns c
                   WHERE c.table_schema = 'public'
                     AND c.table_name  = t.tablename
                     AND c.column_name = 'tenantId')
    ORDER BY t.tablename;"
   ```
   **Pass = every row shows `rowsecurity = t`, `policyname = tenant_isolation`,
   `has_using = t`, `has_with_check = t`.** Any row failing any column blocks the
   deploy. Also confirm the only public tables *without* `tenantId` are `Tenant` and
   `_prisma_migrations`:
   ```sh
   psql '<direct owner url>' -c "
   SELECT tablename FROM pg_tables t
    WHERE schemaname = 'public'
      AND NOT EXISTS (SELECT 1 FROM information_schema.columns c
                       WHERE c.table_schema = 'public'
                         AND c.table_name  = t.tablename
                         AND c.column_name = 'tenantId');"
   ```
4. Spot-check the app role is actually fenced (no GUC → zero rows, not an error):
   ```sh
   psql '<pooled wezesha_app url>' -c 'SELECT count(*) FROM "Tenant";'
   ```
   Expect `0` even after tenants exist — `wezesha_app` without `app.tenant_id` set
   must see nothing on RLS-guarded paths (Tenant is global, so this returns real
   counts; run the same against any tenant table once one exists and expect 0).

## 4. Railway — Redis first, then the two services

1. **New project** (e.g. `wezesha-restock`).
2. **Redis first:** Create → Database → **Redis**. Note the generated variables
   (`REDIS_URL`, and the private-network variant if shown).
3. **ws-gateway service:** Create → GitHub Repo → select the repo.
   - Settings → **Config File Path** → `apps/ws-gateway/railway.json` (this makes the
     build use `apps/ws-gateway/Dockerfile` with the repo root as context; leave Root
     Directory unset).
   - Variables: `REDIS_URL = ${{Redis.REDIS_URL}}` (prefer the private-URL reference
     if the plugin exposes one), plus `DATABASE_URL` and `SERVICE_DATABASE_URL` — the
     gateway authorizes each socket against the caller's session and resolves the
     tenant through `Membership`, so it needs database access. Leave `WS_DEV_TOKEN`
     unset in production; the gateway ignores it there anyway.
   - Settings → Networking → **Generate Domain** (public). Note it: the browser and
     smoke tests connect to `wss://<gateway-domain>`, and it is the value of web's
     `NEXT_PUBLIC_WS_URL` in section 5.
   - Deploy branch: `main` for production. (A second environment tracking `develop`
     is optional; add later.)
4. **worker service:** Create → GitHub Repo → same repo.
   - Settings → **Config File Path** → `apps/worker/railway.json`.
   - Variables: `REDIS_URL = ${{Redis.REDIS_URL}}` (same reference), `DATABASE_URL`,
     `SERVICE_DATABASE_URL`, `TOKEN_ENCRYPTION_KEY` and `SHOPIFY_APP_URL`.
   - **Decide the schedules here.** Every cron group is off unless set to `1`:
     `FORECAST_CRON`, `COST_CRONS`, `POS_CRONS`, `OPS_CRONS`, `EMAIL_CRONS`,
     `SNAPSHOT_CRON`. A worker deployed with none of them set runs no nightly work —
     no forecast, no on-hand snapshots, so no stockout-rate or dead-stock trend. Set
     the ones this environment should run. Full list: `deploy/ENVIRONMENT.md`.
   - No public networking — the worker listens on nothing.
5. **Shared variables:** if Railway offers project-level Shared Variables in the
   current UI, put nothing secret at project scope yet — with only `REDIS_URL` shared
   between two services, per-service references are simpler and more auditable.
6. Watch both deploys:
   - gateway logs → `ws-gateway listening on :<port>`
   - worker logs → `worker: listening on queue "sync"`

## 5. Vercel — web

1. **Add New → Project** → import the GitHub repo.
2. **Root Directory** → `apps/web` (this is a project setting; it cannot live in
   `vercel.json`). Keep "Include source files outside of the Root Directory" enabled
   (default) — the workspace install needs the repo root.
3. Framework preset: Next.js. Install/build commands come from `apps/web/vercel.json`
   (`cd ../.. && npm ci` so the workspace root installs; `next build`).
4. Settings → Git → **Production Branch: `main`**. Every other branch — including
   `develop` — deploys as a Preview automatically.
5. Environment variables per `deploy/ENVIRONMENT.md`, set for Production and Preview
   separately — previews never get prod credentials. **The build fails without these
   four**, so set them before the first deploy:
   - `SERVICE_DATABASE_URL` and `DATABASE_URL` — web imports `@wezesha/db`, and the
     db package throws at module load when the service URL is missing.
   - `BETTER_AUTH_SECRET` (generate per environment: `openssl rand -base64 32`) and
     `BETTER_AUTH_URL` (that environment's public origin, no trailing slash).

   Then the rest as the environment needs them: `REDIS_URL`, `NEXT_PUBLIC_WS_URL`
   (`wss://<gateway-domain>` from section 4 — without it the app never opens a socket),
   the Shopify credentials, `TOKEN_ENCRYPTION_KEY` (same value as the worker),
   `BREVO_API_KEY` / `EMAIL_FROM`, `ADMIN_EMAILS`, `SENTRY_DSN`. Do not set
   `NEXT_OUTPUT` — it is for the Docker image only.
6. Deploy; confirm the production URL renders and `/api/health` returns `db: true`.

## 6. Smoke tests

**Which socket tests run where.** The dev-token round-trip below only works against a
gateway running outside production: `apps/ws-gateway/src/index.ts` ignores
`WS_DEV_TOKEN` when `NODE_ENV=production`, so a production gateway accepts nothing but
a real Better Auth session token. Run the full token-based pipeline test on the local
staging stack or a staging Railway environment; against production, verify the socket
path by signing in to the deployed app and watching a sync update the UI live.

Fail-closed check — safe and meaningful against production, expect an immediate `4401`:

```sh
npx wscat -c "wss://<gateway-domain>/?token=definitely-not-a-session"
```

Gateway process health, against production:

```sh
curl -sS https://<gateway-domain>/healthz     # {"uptime":...,"connections":...}
```

Full pipeline (queue → worker → Redis pub/sub → gateway → socket) with the repo's
smoke script — **staging/non-production only**, and needs a Redis URL reachable from
your machine (the Redis service's public/proxy URL; if only private networking is
enabled, run it from a one-off Railway shell instead):

```sh
REDIS_URL='<redis public url>' \
WS_URL='wss://<staging gateway domain>' \
WS_TOKEN='<WS_DEV_TOKEN>:smoke-tenant' \
npx tsx deploy/scripts/smoke-enqueue.ts
```

Expect three `sync.progress` events (fetch/transform/load), then
`smoke: sync.done received — pipeline OK`; exit code 0. (Same script and expected
output as the local staging rehearsal above — deploy day should hold no surprises.)

Cross-tenant spot check, same environment: connect a second socket as a different
tenant and confirm it receives nothing during a smoke run:

```sh
npx wscat -c "wss://<staging gateway domain>/?token=<WS_DEV_TOKEN>:other-tenant"
```

Web, against production:

```sh
curl -sSI https://<vercel-domain>/ | head -1            # expect HTTP/2 200
curl -sS https://<vercel-domain>/api/health             # ok:true, db:true, worker:true
```

## Per-tenant onboarding — POS ingest secrets

Not a deploy-day step, but the first thing a new shop with a till needs. There is no
global POS credential: `POST /api/pos/ingest` authenticates against a secret stored per
tenant (hashed) on `TenantConfig`, and **a tenant with none issued is closed** — every
call answers 401.

Issue one from `packages/pos`, with the environment's `SERVICE_DATABASE_URL` in the
shell:

```sh
cd packages/pos
npx tsx scripts/provision-ingest-secret.ts <tenant-slug>
```

It prints the secret once and stores only its SHA-256. Put the value into the POS
bridge's credential store immediately — it cannot be read back, only rotated, and
re-running the script kills the previous secret. Rotating means coordinating with
whoever runs the bridge, or that shop's sales stop flowing.

## Uptime monitoring (external pingers)

The contract's line: the app going down triggers an alert within minutes. Three
services, three signals — all watchable by a plain HTTP pinger with zero deploy
changes:

| Service | Probe | Healthy looks like |
|---|---|---|
| web | `GET https://<vercel-domain>/api/health` | HTTP 200, body `{"ok":true,"db":true,...}` (503 when the DB check fails — the pinger alarms on that too) |
| ws-gateway | `GET https://<gateway-domain>/healthz` | HTTP 200, body `{uptime, connections}` |
| worker | no port — watched THROUGH web `/api/health` | `"worker":true` in the same body |

How the worker signal works: the worker refreshes the Redis key
`ops:worker:heartbeat` every 30s with a 90s TTL (`apps/worker/src/heartbeat.ts`);
`/api/health` reports the key's presence as `worker` (`true` = beating, `false` =
key gone → worker dead or hung, `null` = Redis itself unreachable — a separate
problem the same probe surfaces).

**UptimeRobot setup (free tier, ~10 minutes, owner action):**

1. Create the account; add an alert contact (email at minimum; Slack webhook if
   the workspace has one).
2. **Web + DB:** Add New Monitor → type HTTP(s) → URL
   `https://<vercel-domain>/api/health` → interval 5 min. A 503 (db down) or
   timeout (app down) alerts.
3. **Worker:** Add New Monitor → type **Keyword** → same URL → keyword
   `"worker":true` → alert when keyword **not exists** → interval 5 min. This
   fires when the heartbeat key vanishes even though web itself is fine.
4. **Gateway:** Add New Monitor → type HTTP(s) → URL
   `https://<gateway-domain>/healthz` → interval 5 min.
5. Send a test alert; confirm it reaches a human.

**Upptime alternative** (GitHub-native, no third-party account): create a repo
from the `upptime/upptime` template and list the three URLs in `.upptimerc.yml`
(`sites:` entries; for the worker signal use the same `/api/health` URL with
`__dangerous__body_down_if_text_missing: '"worker":true'`). GitHub Actions pings
on a ~5-minute schedule and opens an issue on failure. Choose one system, not
both — two alerting stacks means both get ignored.

To verify the wiring end-to-end after setup: stop the worker service in Railway
for ~3 minutes (heartbeat TTL 90s + one probe interval) and confirm the keyword
monitor alarms, then restart it.

## 7. Rollback

- **Vercel:** Deployments → previous good deployment → **Promote to Production**
  (instant rollback, no rebuild).
- **Railway:** service → Deployments → previous good deployment → **Redeploy**. The
  restart policy already handles crash-loops; rollback is for bad-but-running builds.
- **Database:** migrations are forward-only — default to roll-forward with a fixing
  migration. If a deployed migration must be undone:
  1. Restore the data (PITR to just before the migration, section 8) or manually
     revert the schema change on a verified copy first.
  2. Mark it rolled back so Prisma's ledger matches reality:
     ```sh
     DIRECT_URL='<direct owner url>' npx prisma migrate resolve \
       --rolled-back <migration-name> --schema packages/db/prisma/schema.prisma
     ```
  3. Re-run the RLS census (section 3.3) before letting traffic back — a partial
     rollback that drops a policy is a cross-tenant leak, not an inconvenience.
- App rollback and DB rollback are independent; when a deploy pairs a code change
  with a migration, roll the app back first (old code must tolerate the new schema —
  keep migrations additive for exactly this reason).

## 8. Backups & restore

**Enable now (step 1.2):** PITR on the prod project, 7-day minimum retention.
Also decide and record: who owns the vault entries, and where the restore drill log
lives.

**Restore paths — know both, drill the second:**

- **PITR (real-incident path).** Supabase PITR restores **in place** on the same
  project: Console → Project → Database → Backups → Point in Time → pick the
  timestamp → Restore. In-place means it overwrites the live database — this is
  the tool for an actual incident, never for a drill against prod.
- **Dump-and-restore to a scratch project (the drill, and the fallback when PITR
  can't help).** Proves the data is recoverable end-to-end without touching prod.

**Restore drill — run this once, as soon as the Supabase project exists. Until it has
been run and the log below filled in, treat "we can restore" as an untested claim.**

1. Record the start time. Create a scratch project: Console → New project →
   `wezesha-restore-drill`, any strong password (vault not required — it dies with
   the drill), same region as prod.
2. Create the roles on the scratch project FIRST (SQL Editor → contents of
   `packages/db/prisma/sql/prod-roles.sql`, drill-only passwords). The dump
   carries grants and RLS policies that reference `wezesha_app` /
   `wezesha_service`; restoring before the roles exist fails half-way.
3. Dump prod through the direct connection (read-only against prod):
   ```sh
   pg_dump -d '<prod direct owner url>' -Fc -f drill.dump
   ```
4. Restore into the scratch project's direct connection:
   ```sh
   pg_restore --no-owner -d '<scratch direct owner url>' drill.dump
   ```
5. Run the RLS census (section 3.3 queries) against the scratch project — a
   restore that comes back without `rowsecurity = t` + a two-sided
   `tenant_isolation` policy on every tenant table is a leak, not a recovery.
   Also spot-check fail-closed: `SELECT count(*) FROM "Product";` as
   `wezesha_app` with no GUC must return 0.
6. Row-count spot checks vs prod, same moment, per big table
   (`Product`, `SalesHistory`, `Order`, `PurchaseOrder`, `Notification`):
   ```sh
   psql '<url>' -c 'SELECT count(*) FROM "SalesHistory";'
   ```
7. Point a local web instance at the scratch project (swap the three DB URLs in
   env) and verify: login works, /today renders, one read path per module
   (stock, plan, orders), and `/api/health` reports `db: true`.
8. Record in the drill log: wall-clock time to restored-and-verified, dump size,
   data window lost (dump timestamp vs incident timestamp — for PITR this is
   near-zero, for dump-based it is up to a day), every step that surprised you.
9. Tear the scratch project down (Console → Project Settings → Delete project).

Drill log (fill in when run): date ______ · operator ______ · time-to-restore
______ · dump size ______ · surprises ______

## 9. Follow-ups (known, deliberate deferrals)

- **Gateway `/healthz`:** done — the gateway serves `GET /healthz` (200,
  `{uptime, connections}`) on its ws port and the Dockerfile HEALTHCHECK probes it.
  Remaining owner step: point the Railway health check at `/healthz` (step 4).
- **Worker DB access:** done — the sync writes through the service client;
  `deploy/ENVIRONMENT.md` lists the worker's DB URLs.
- **Uptime monitors:** the endpoints and heartbeat ship with the repo; creating
  the UptimeRobot/Upptime monitors (section "Uptime monitoring") is an owner
  action — do it right after the first deploy.
- **Error tracking DSNs:** all three services init the tracker only when
  `SENTRY_DSN` is set. Creating the Sentry org/projects and setting the DSNs is
  an owner action; no code change needed when they arrive.
- **Restore drill:** section 8's drill has to be run once the Supabase project
  exists, with the drill log filled in. Nothing in the repo can do it — it needs a
  live project and a scratch project to restore into.
- **POS ingest secrets:** each tenant whose till posts to `/api/pos/ingest` needs its
  own secret issued (see "Per-tenant onboarding"). Until then that tenant's ingest is
  closed.

## 10. Owner-only actions (cannot be prepared in the repo)

Everything above assumes these accounts/switches, which only the account owner can do:

1. Supabase: create org/project, choose plan (PITR requires Pro), run prod-roles.sql,
   generate/record passwords.
2. Railway: create project, provision Redis, connect the GitHub repo to two services,
   set the two config-file paths, set variables, generate the gateway domain.
3. Vercel: import repo, set Root Directory, set Production Branch, set env vars.
4. GitHub: no new secrets needed for CI today (the db job uses a service container);
   Railway/Vercel connect via their own GitHub apps.
5. Vault: store the owner DB password, the two role passwords, the three URLs, each
   environment's `BETTER_AUTH_SECRET`, the shared `TOKEN_ENCRYPTION_KEY`, and every
   per-tenant POS ingest secret handed to a bridge.
6. Sentry (or compatible): create the org + project(s), copy the DSN(s), set
   `SENTRY_DSN` on Vercel and both Railway services.
7. UptimeRobot or Upptime: create the monitors per the "Uptime monitoring"
   section and confirm a test alert reaches a human.
