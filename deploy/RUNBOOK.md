# First-deploy runbook

Ordered checklist for standing up production: Supabase (Postgres) → Railway
(Redis + ws-gateway + worker) → Vercel (web). Every step is either a console click
path or an exact command. Prerequisites: repo access, a Supabase org, a Railway
account, a Vercel account, a secrets vault, and locally `node` 22 + `npm` + `psql`.

Environment variables are catalogued in `deploy/ENVIRONMENT.md` — this file only says
*when* to set them.

---

## 0. Decisions baked into this setup

- **Services are compiled, not tsx-run.** `npm run build` in `apps/ws-gateway` and
  `apps/worker` bundles `src/index.ts` with esbuild into a single self-contained
  `dist/index.cjs`; the Docker runner stage is bare `node:22-alpine` + that file, no
  `node_modules`, running as the non-root `node` user. Why not the alternatives:
  plain `tsc` can't emit a runnable build here because `@wezesha/realtime` exports
  raw TypeScript source (`"." : "./src/index.ts"`) — compiled JS would still import
  a `.ts` file at runtime; running tsx in prod works but ships the whole TS
  toolchain and node_modules into the image for a slower, fatter, less inspectable
  deploy. The bundle keeps dev ergonomics (tsx + live workspace source) and prod
  hygiene (one artifact). esbuild does not typecheck — CI's `services-typecheck`
  job holds that line.
- **Bundle externals** (resolved at runtime via try/require with pure-JS fallback,
  absent from the runner image by design): `bufferutil`, `utf-8-validate` (ws) for
  the gateway; `msgpackr-extract` (bullmq → msgpackr) for the worker.
- **Docker build context is the repo root** (both Dockerfiles start
  `docker build -f apps/<svc>/Dockerfile .`) so the lockfile and workspace graph are
  visible; `npm ci -w <service>` prunes the install to that service's subtree.
- **Railway config-as-code** is per-service `railway.json` (`apps/ws-gateway/railway.json`,
  `apps/worker/railway.json`): Dockerfile builder + on-failure restart policy. Each
  Railway service points at the same repo with its own **Config File Path** (step 4).
  Root Directory stays the repo root — do not set it per service, or the Docker build
  context loses the workspace graph.
- **No Railway health check for the gateway.** Railway's health checks are HTTP-only
  and the gateway speaks only WebSocket. The Dockerfile HEALTHCHECK (TCP on the ws
  port) covers docker-level supervision; Railway's restart policy covers crashes.
  Adding a plain HTTP `/healthz` to the gateway is a sensible follow-up.

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

curl -sSI http://localhost:${WEB_PORT}/today | head -1      # HTTP/1.1 200 OK

# fail-closed auth: wrong token must close with 4401
npx wscat -c "ws://localhost:${WS_GATEWAY_PORT}/?token=wrong:smoke-tenant"

# full pipeline: queue -> worker -> redis pub/sub -> gateway -> socket
REDIS_URL=redis://localhost:${REDIS_PORT} \
WS_URL=ws://localhost:${WS_GATEWAY_PORT} \
WS_TOKEN=${WS_DEV_TOKEN}:smoke-tenant \
npx tsx deploy/scripts/smoke-enqueue.ts
# expect three sync.progress events, then "smoke: sync.done received — pipeline OK"
```

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
     if the plugin exposes one), `WS_DEV_TOKEN = <generated secret from vault>`.
   - Settings → Networking → **Generate Domain** (public). Note it: the browser and
     smoke tests connect to `wss://<gateway-domain>`.
   - Deploy branch: `main` for production. (A second environment tracking `develop`
     is optional; add later.)
4. **worker service:** Create → GitHub Repo → same repo.
   - Settings → **Config File Path** → `apps/worker/railway.json`.
   - Variables: `REDIS_URL = ${{Redis.REDIS_URL}}` (same reference).
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
5. Environment variables per `deploy/ENVIRONMENT.md` (today: none required for the
   static shell on `develop`; DB + AUTH vars arrive with the auth branch — set them
   for Production and Preview separately, previews never get prod credentials).
6. Deploy; confirm the production URL renders.

## 6. Smoke tests

Gateway reachability (expect an open socket, no immediate 4401 close; Ctrl-C to exit):

```sh
npx wscat -c "wss://<gateway-domain>/?token=<WS_DEV_TOKEN>:smoke-tenant"
```

A rejected token closes with `4401` — verifies fail-closed auth too (try once with a
wrong token).

Full pipeline (queue → worker → Redis pub/sub → gateway → socket) with the repo's
smoke script — needs a Redis URL reachable from your machine (the Redis service's
public/proxy URL; if only private networking is enabled, run it from a one-off
Railway shell instead):

```sh
REDIS_URL='<redis public url>' \
WS_URL='wss://<gateway-domain>' \
WS_TOKEN='<WS_DEV_TOKEN>:smoke-tenant' \
npx tsx deploy/scripts/smoke-enqueue.ts
```

Expect three `sync.progress` events (fetch/transform/load), then
`smoke: sync.done received — pipeline OK`; exit code 0. (Same script and expected
output as the local staging rehearsal above — deploy day should hold no surprises.)

Web:

```sh
curl -sSI https://<vercel-domain>/ | head -1     # expect HTTP/2 200
```

Cross-tenant spot check: connect a second socket as a different tenant and confirm it
receives nothing during a smoke run:

```sh
npx wscat -c "wss://<gateway-domain>/?token=<WS_DEV_TOKEN>:other-tenant"
```

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

**Restore procedure — REQUIRED M10 exercise, placeholder until then:**

> A backup that has never been restored is a hope, not a backup. Before M10 sign-off,
> run a full drill and replace this placeholder with the measured results:
>
> 1. PITR-restore prod to a **new scratch Supabase project** at a timestamp minutes in
>    the past (never in-place).
> 2. Run the RLS census (section 3.3) against the restored copy — restores must come
>    back with policies intact.
> 3. Row-count spot checks per tenant table against prod at the same timestamp.
> 4. Point a local app instance at the restored copy; verify login + one read path
>    per module.
> 5. Record: time to restore, data window lost, every manual step that surprised you.
> 6. Tear the scratch project down.
>
> Until this drill has been run once, treat restore as **unverified**.

## 9. Follow-ups (known, deliberate deferrals)

- **Gateway `/healthz`:** the Dockerfile HEALTHCHECK is a TCP check on the ws port
  because the gateway currently exposes no HTTP endpoint and its source is being
  reworked on the auth-seam branch — add a plain HTTP `/healthz` there, then switch
  the HEALTHCHECK and enable a Railway health check against it.
- **Worker DB access:** real source syncs will add `SERVICE_DATABASE_URL` to the
  worker service; update `deploy/ENVIRONMENT.md` when that lands.
- **Restore drill:** section 8's placeholder is a required M10 exercise.

## 10. Owner-only actions (cannot be prepared in the repo)

Everything above assumes these accounts/switches, which only the account owner can do:

1. Supabase: create org/project, choose plan (PITR requires Pro), run prod-roles.sql,
   generate/record passwords.
2. Railway: create project, provision Redis, connect the GitHub repo to two services,
   set the two config-file paths, set variables, generate the gateway domain.
3. Vercel: import repo, set Root Directory, set Production Branch, set env vars.
4. GitHub: no new secrets needed for CI today (the db job uses a service container);
   Railway/Vercel connect via their own GitHub apps.
5. Vault: store owner DB password, two role passwords, three URLs, `WS_DEV_TOKEN`.
