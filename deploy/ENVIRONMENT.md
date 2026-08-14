# Environment variables

Every variable any service reads, where it is read, which platform sets it, and what
class of value it is. Source of truth is the code — each entry cites the read site.
No real values live in this file or anywhere in the repo; production values come from
the vault and are entered directly into each platform's dashboard.

Value classes: **secret** (credential — vault + platform secret store only),
**config** (non-sensitive setting), **url** (connection string; treat as secret when
it embeds a password).

## Matrix

| Variable | Read at | Service(s) | Set by / on | Class | Local default |
|---|---|---|---|---|---|
| `DATABASE_URL` | `packages/db/prisma/schema.prisma` (datasource `url`) | web, worker, ws-gateway (all import `@wezesha/db`); Prisma CLI | Vercel (web); Railway (worker, ws-gateway); CI; local `.env` | url (secret) | `postgresql://wezesha_app:wezesha_app_dev@localhost:5434/wezesha` |
| `SERVICE_DATABASE_URL` | `packages/db/src/client.ts` (`prismaService`) | web, worker, ws-gateway — the BYPASSRLS client | Vercel (web); Railway (worker, ws-gateway); CI; local `.env` | url (secret) | `postgresql://wezesha_service:wezesha_service_dev@localhost:5434/wezesha` |
| `DIRECT_URL` | `packages/db/prisma/schema.prisma` (datasource `directUrl`) | Prisma CLI only (`migrate deploy`); RLS test suite | wherever migrations run (ops machine or CI); never a runtime platform | url (secret) | `postgresql://postgres:postgres@localhost:5434/wezesha` |
| `BETTER_AUTH_SECRET` | Better Auth reads it from the environment (`apps/web/lib/auth.ts` passes no explicit secret); `apps/web/lib/admin/impersonation.ts` also signs the admin workspace cookie with it | web | Vercel | secret | `change-me` in `apps/web/.env.example` — generate a real one per environment (`openssl rand -base64 32`) |
| `BETTER_AUTH_URL` | `apps/web/app/layout.tsx` (`metadataBase` for canonical/OG URLs); `apps/web/lib/auth/invites.ts` (invite links — throws when unset); Better Auth's own base URL | web | Vercel | url (config) | `http://localhost:3000` |
| `PORT` | `apps/ws-gateway/src/index.ts` | ws-gateway | Railway (injected automatically) | config | `8081` |
| `REDIS_URL` | `apps/ws-gateway/src/index.ts`; `apps/worker/src/index.ts`; `apps/web/lib/shopify/queue.ts`, `apps/web/lib/pos/queue.ts`, `apps/web/app/api/health/route.ts` | web, worker, ws-gateway | Vercel (web); Railway (reference to the Redis service, see below) | url (secret) | `redis://localhost:6380` |
| `NEXT_PUBLIC_WS_URL` | `apps/web/app/api/realtime-token/route.ts` | web | Vercel | url (config) | unset (the token route returns `url: null` and the realtime client hooks stay idle — the app works, it just doesn't live-update) |
| `WS_DEV_TOKEN` | `apps/ws-gateway/src/index.ts` | ws-gateway, **non-production only** | Railway (staging/preview environments only) | secret | unset (no dev tokens accepted; real sessions still authorize) |
| `NEXT_OUTPUT` | `apps/web/next.config.ts` | web, **build time only** | set to `standalone` by `apps/web/Dockerfile`; leave unset on Vercel | config | unset (default Next output) |
| `NODE_ENV` | `apps/web/components/sw-register.tsx`; `packages/db/src/client.ts`; `apps/ws-gateway/src/index.ts` (gates the dev token) | web, ws-gateway; db consumers | set by Vercel/Next and the Dockerfiles automatically — never set by hand | config | `development` |
| `SHOPIFY_APP_URL` | `apps/web/lib/shopify/env.ts`; `apps/worker/src/shopify-sync.ts` | web (OAuth redirect URI); worker (webhook registration) | Vercel; Railway | url (config) | `http://localhost:3000` (OAuth/webhooks need a public tunnel locally) |
| `TOKEN_ENCRYPTION_KEY` | `packages/shopify/src/crypto.ts` (via web callback + worker sync) | web, worker | Vercel; Railway — SAME value on both | secret | unset (token store/read throws) |
| `POS_FEED_SECRET` | `apps/worker/src/pos-sync.ts` (passed to `packages/pos/src/feed.ts`) | worker | Railway | secret | unset (the feed GET goes out with no `Authorization` header — only matters for tenants that have `TenantConfig.posFeedUrl` set) |
| `EMAIL_CRONS` | `apps/worker/src/index.ts` | worker | Railway (`1` to send the weekly summaries) | config | unset — schedule OFF |
| `OPS_CRONS` | `apps/worker/src/index.ts` | worker | Railway (`1` to run the daily plan-limit check) | config | unset — schedule OFF |
| `POS_CRONS` | `apps/worker/src/index.ts` | worker | Railway (`1` to run the daily POS sales-gap check) | config | unset — schedule OFF |
| `FORECAST_CRON` | `apps/worker/src/index.ts` | worker | Railway (`1` to run the nightly forecast + monthly backtest) | config | unset — schedule OFF |
| `COST_CRONS` | `apps/worker/src/index.ts` | worker | Railway (`1` to run the nightly cost-moved check) | config | unset — schedule OFF |
| `SNAPSHOT_CRON` | `apps/worker/src/index.ts` (gates `apps/worker/src/snapshot-cron.ts`) | worker | Railway (`1` everywhere on-hand history is wanted — stockout-rate and dead-stock trends read off it) | config | unset — schedule OFF |
| `SHOPIFY_SYNC_CRON` | `apps/worker/src/index.ts` (gates `apps/worker/src/sync-schedule-cron.ts`) | worker | Railway (`1` in production — without it a shop's data only refreshes when someone presses Sync now) | config | unset — schedule OFF |
| `SHOPIFY_SYNC_PATTERN` | `apps/worker/src/sync-schedule-cron.ts` | worker | Railway (only to re-time the sync) | config | `*/15 * * * *`. Ten minutes is the floor worth considering: a tick does a full inventory refresh, and the app calls a run stalled once its progress has been quiet for ten |
| `RESEND_API_KEY` | `apps/web/lib/email.ts`; `apps/worker/src/email.ts` | web, worker | Vercel (web); Railway (worker) | secret | unset — outside production mail is logged to the console, never sent (dev/CI/tests stay offline). **With `NODE_ENV=production` every send throws instead** |
| `EMAIL_FROM` | `apps/web/lib/email.ts`; `apps/worker/src/email.ts` | web, worker | Vercel (web); Railway (worker) | config | unset (only read when `RESEND_API_KEY` is set; sender as `Name <address>` or a bare address) |
| `ADMIN_EMAILS` | `apps/web/lib/admin/gate.ts` | web | Vercel | config (sensitive — names the operator accounts) | unset. Bootstrap only: it answers who is an admin while the `PlatformAdmin` table has no live row, and goes inert once one does. With both empty the console 404s for everyone — fail closed |
| `SENTRY_DSN` | `packages/observability/src/index.ts` (via each service's init) | web (`apps/web/instrumentation.ts`) | Vercel | secret | unset (error tracking disabled — complete no-op) |
| `SENTRY_DSN` | same | worker (`apps/worker/src/index.ts`) | Railway | secret | unset (no-op) |
| `SENTRY_DSN` | same | ws-gateway (`apps/ws-gateway/src/index.ts`) | Railway | secret | unset (no-op) |
| `SENTRY_ENVIRONMENT` | `packages/observability/src/index.ts` | web, worker, ws-gateway | Vercel; Railway (e.g. `production` / `preview`) | config | unset (falls back to `NODE_ENV`) |
| `SENTRY_RELEASE` | `packages/observability/src/index.ts` | web, worker, ws-gateway | optional — set by the deploy pipeline if release tagging is wanted | config | unset |

One read site is deliberately left out: `NEXT_RUNTIME`, which Next injects and
`apps/web/instrumentation.ts` branches on. Nothing sets it by hand.

Notes:

- **Sockets authorize against real sessions.** `apps/ws-gateway/src/auth.ts` exports
  `sessionAuthorizeSocket`, which validates the caller's Better Auth session token
  against the `Session` table and resolves the tenant through `Membership` — so the
  gateway needs `SERVICE_DATABASE_URL` (and `DATABASE_URL` for client construction).
  `WS_DEV_TOKEN` is the non-production convenience only: `apps/ws-gateway/src/index.ts`
  ignores it entirely when `NODE_ENV=production`. Setting it on a production service
  does nothing; leave it off there.
- **web needs the DB URLs.** `apps/web` depends on `@wezesha/db` (see its
  `package.json` and the `serverExternalPackages: ["@wezesha/db"]` entry in
  `apps/web/next.config.ts`); pages such as `/settings/connections` import
  `prismaForTenant`. `packages/db/src/client.ts` throws at module load when
  `SERVICE_DATABASE_URL` is unset, so a build or a request fails without it — this is
  not optional.
- **web needs the auth variables.** `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` are
  required, not nice-to-have: the build evaluates route modules that initialize Better
  Auth, which is why both CI (`.github/workflows/ci.yml`) and `apps/web/Dockerfile` set
  build-only placeholders. Deploy without them and the build fails. Generate a distinct
  secret per environment and never share one between preview and production;
  `BETTER_AUTH_URL` is that environment's public origin, no trailing slash.
- **web also needs `REDIS_URL`**: OAuth callback, sync-now, webhook and POS routes
  enqueue worker jobs (`apps/web/lib/shopify/queue.ts`, `apps/web/lib/pos/queue.ts`).
- **worker needs the DB URLs**: the sync writes through the service client, so set
  `SERVICE_DATABASE_URL` + `DATABASE_URL` (client construction) alongside `REDIS_URL`,
  `TOKEN_ENCRYPTION_KEY`, and `SHOPIFY_APP_URL` on Railway.
- **Every scheduled job is off unless switched on.** `EMAIL_CRONS`, `OPS_CRONS`,
  `POS_CRONS`, `FORECAST_CRON`, `COST_CRONS`, `SNAPSHOT_CRON` and `SHOPIFY_SYNC_CRON`
  each register their schedules only when the value is exactly `"1"`
  (`apps/worker/src/index.ts`). Unset is the default everywhere, which keeps dev and CI
  quiet — and means a production worker that should run the nightly forecast, cost
  checks, on-hand snapshots and the recurring Shopify sync does nothing until those are
  set to `1` on Railway. Decide this deliberately per environment.
- **`SHOPIFY_SYNC_CRON` is the one a customer notices immediately.** Without it a shop's
  catalogue, stock and sales only move when someone presses Sync now or a webhook
  happens to fire, so the buy list can be hours stale. It also carries the daily full
  pull that lets products deleted in Shopify be noticed at all.
- **Realtime needs `NEXT_PUBLIC_WS_URL` on web.** The gateway can be up and reachable
  and the app will still never connect: `/api/realtime-token` returns `url: null` when
  the variable is unset. Point it at the gateway's `wss://` origin once the Railway
  domain exists.
- **`TOKEN_ENCRYPTION_KEY` is one key, two services.** The web callback encrypts the
  store token; the worker decrypts it per sync. Rotating it invalidates stored
  connections (stores must reconnect) — treat rotation as an offboarding-grade event.
- **Shopify app credentials** come from the app entry in the Shopify Dev Dashboard.
  The app's redirect URL allow-list must contain `<SHOPIFY_APP_URL>/api/shopify/callback`
  per environment.
- **`SENTRY_DSN` is one variable, three projects.** Each service inits the tracker
  with its own `service` tag, so one shared DSN works — but separate Sentry projects
  per service (three DSNs) keep alert routing cleaner. Either way, no DSN = tracking
  is a complete no-op (the SDK is not even loaded); nothing else changes. When DSNs
  arrive, set them and redeploy — no code change needed, and error tracking is only
  considered live once a deployed service has reported into the Sentry project.
- **`RESEND_API_KEY` is required in production, on both web and worker.** Vercel and
  Railway both run with `NODE_ENV=production`, and there a missing key makes every send
  throw rather than fall back to the console. That is deliberate: the old silence let a
  shop see a purchase order marked sent when nothing had left the building. Deploy
  without the key and invites, sign-in codes, purchase orders, reconnect alerts and
  weekly summaries all fail — loudly, and with a `failed` row in `EmailLog`. Set
  `EMAIL_FROM` with it; a key without a sender throws too.
- **`/api/health` (web) also reads `REDIS_URL`** to report the worker's heartbeat
  key (`ops:worker:heartbeat`); with no `REDIS_URL` the endpoint still works and
  reports `worker: null` (unknown).
- **Admin-adjacent ops routes** (`/api/ops/export`, `/api/ops/delete`) read no new
  env: they are session-guarded (OWNER + manage_settings) and resolve the tenant
  from the membership. The delete route stays test-tenants-only until the owner
  signs off (see the loud comment in the route and the production-safety rule).

## POS ingest — a per-tenant secret, not an environment variable

`POST /api/pos/ingest` is how a shop's till pushes physical sales in. It has no
session, so the credential is a bearer secret — but that secret is **per tenant and
lives in the database**, not in the platform's environment. `packages/pos/src/auth.ts`
verifies the presented secret against `TenantConfig.posIngestSecretHash` for the tenant
the request's `slug` resolved to, so a bridge holding one shop's secret can never write
another shop's sales. Only the SHA-256 is stored.

Consequences an operator has to plan for:

- **A tenant with no secret provisioned is closed.** There is no process-wide fallback
  credential to inherit — every ingest call for that tenant answers 401. Provisioning
  is a per-tenant onboarding step, not a deploy step.
- **Issue or rotate a secret** from `packages/pos`, against the environment's database
  (the script reads `SERVICE_DATABASE_URL`):

  ```sh
  npx tsx scripts/provision-ingest-secret.ts <tenant-slug>
  ```

  It prints the secret **once** and stores only the hash — a lost secret is rotated,
  never recovered. Re-running kills the previous one, so coordinate with whoever runs
  the bridge. Put the value straight into the bridge's credential store.
- **`POS_FEED_SECRET` is the opposite direction** and unrelated: it is the token the
  worker *sends outbound* when it pulls a provider's feed URL. Do not confuse the two.

## The three-URL database model (Supabase)

Three connections, three privilege levels — the rationale lives in
`packages/db/src/client.ts` and `packages/db/prisma/sql/prod-roles.sql`:

| Variable | Postgres role | Privilege | Route |
|---|---|---|---|
| `DATABASE_URL` | `wezesha_app` | RLS **enforced** | pooled (Supavisor, transaction mode) |
| `SERVICE_DATABASE_URL` | `wezesha_service` | `BYPASSRLS` | pooled (Supavisor, transaction mode) |
| `DIRECT_URL` | `postgres` (owner) | full — migrations only | direct to the database |

Production URL shapes (substitute `<project-ref>`, `<region>`, and vault passwords).
**`connection_limit` differs between the web app and the worker** — see the pool-size
note below; it is not a value to copy between them.

```
# Vercel (serverless: many short-lived instances, one query at a time)
DATABASE_URL=postgresql://wezesha_app.<project-ref>:<app-role-password>@aws-0-<region>.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1
SERVICE_DATABASE_URL=postgresql://wezesha_service.<project-ref>:<service-role-password>@aws-0-<region>.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1

# Railway worker (one long-lived process running several queues concurrently)
DATABASE_URL=…same host/role/password…?pgbouncer=true&connection_limit=10&pool_timeout=20
SERVICE_DATABASE_URL=…same host/role/password…?pgbouncer=true&connection_limit=10&pool_timeout=20

DIRECT_URL=postgresql://postgres:<owner-password>@db.<project-ref>.supabase.co:5432/postgres
```

Supabase specifics that are easy to get wrong:

- **Pooled = port 6543, transaction mode.** `pgbouncer=true` disables Prisma prepared
  statements (transaction pooling breaks them). Transaction-mode pooling is exactly what
  the tenant client is designed for — the `app.tenant_id` GUC is set
  transaction-locally in the same transaction as each query (`packages/db/src/client.ts`),
  so nothing leaks across recycled connections.
- **Size `connection_limit` to the process, not to a habit.** `connection_limit=1` is
  advice for *serverless*: many short-lived instances that each run one query at a time,
  where a larger pool per instance just hoards pooled connections. A long-lived container
  running several queues concurrently is the opposite case and needs a real pool — every
  tenant-scoped operation opens its own transaction, so a batch of N reads wants N
  connections and starves itself when the pool is smaller. The nightly forecast failed
  this way for two nights in August. Keep the sum of every service's limit under the
  project's pooler pool size (Supabase → Database → Connection pooling).
- **Pooled usernames are `<role>.<project-ref>`** (Supavisor routing format). Direct
  connections (`:5432` on `db.<project-ref>.supabase.co`) use the plain role name.
- **`DIRECT_URL` is not a runtime variable.** The Prisma *client* never reads it; only
  the CLI does (`migrate deploy`, introspection). Do not set it on Vercel or Railway —
  it exists on the machine running migrations, and in CI for the RLS suite.
- The exact pooler host is shown in Supabase → Project → Connect; copy from there
  rather than constructing by hand.

## Per-platform checklist

**Vercel (web)** — set in Project → Settings → Environment Variables, per environment:

| Variable | Production | Preview | Development |
|---|---|---|---|
| `DATABASE_URL` | prod value | staging/branch DB value — never prod | local |
| `SERVICE_DATABASE_URL` | prod value | staging/branch DB value — never prod | local |
| `BETTER_AUTH_SECRET` | prod secret | separate preview secret — never prod's | local |
| `BETTER_AUTH_URL` | prod origin | preview origin | `http://localhost:3000` |
| `REDIS_URL` | prod Redis | staging Redis — never prod | local |
| `NEXT_PUBLIC_WS_URL` | `wss://<prod gateway domain>` | `wss://<staging gateway domain>` or unset | `ws://localhost:8081` or unset |
| `SHOPIFY_APP_URL` | prod origin | preview origin | tunnel origin |
| `TOKEN_ENCRYPTION_KEY` | prod key (= worker's) | preview key (= staging worker's) | local key |
| `SENTRY_DSN` | prod DSN (when provisioned) | preview DSN or unset | unset |
| `RESEND_API_KEY` | prod key (= worker's) — **required; without it every send throws** | preview key or unset (console fallback) | unset |
| `EMAIL_FROM` | prod sender | preview sender | unset |
| `ADMIN_EMAILS` | bootstrap operator, until the first `PlatformAdmin` row | same or unset | unset |

The first four rows are the ones a deploy fails without: `SERVICE_DATABASE_URL` is read
at module load and `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL` are needed for the build to
evaluate route modules. Do not set `NEXT_OUTPUT` on Vercel — it exists for the Docker
image only.

`develop` deploys as Preview (Production Branch is `main`), so Preview values are what
`develop` runs with. Point Preview at a separate Supabase project or branch database —
previews must never hold prod credentials.

**Railway (ws-gateway)** — service variables:

- `REDIS_URL` = `${{Redis.REDIS_URL}}` (service reference to the Redis service; use the
  private-network variant if available so traffic stays inside the project)
- `DATABASE_URL`, `SERVICE_DATABASE_URL` — same DB values as web for the environment;
  the gateway resolves sessions and memberships through them
- `PORT` — do not set; Railway injects it and the app reads it
- `WS_DEV_TOKEN` — staging/preview only; the gateway ignores it under
  `NODE_ENV=production`
- `SENTRY_DSN` — when provisioned; unset keeps tracking a no-op

**Railway (worker)** — service variables:

- `REDIS_URL` = `${{Redis.REDIS_URL}}` (same reference)
- `DATABASE_URL`, `SERVICE_DATABASE_URL` — same host, role and password as web, but a
  **larger `connection_limit`** (see the pool-size note above). This is the one DB
  setting that must not be copied from web: the worker is a long-lived process running
  several queues at once, and at web's `connection_limit=1` a job that issues a batch of
  reads starves itself
- `TOKEN_ENCRYPTION_KEY` — same value as web for the environment
- `SHOPIFY_APP_URL` — the web origin for the environment (webhook registration)
- `EMAIL_CRONS`, `OPS_CRONS`, `POS_CRONS`, `FORECAST_CRON`, `COST_CRONS`,
  `SNAPSHOT_CRON` — `1` for each schedule this environment should actually run. All
  six are off by default; a production worker with none of them set runs no nightly
  work at all
- `POS_FEED_SECRET` — only when a tenant's POS feed URL is polled by the worker
- `RESEND_API_KEY` — same key as web for the environment. Required on a production
  worker: unset there makes every alert and summary throw (outside production it
  falls back to the console)
- `EMAIL_FROM` — same sender as web for the environment
- `SENTRY_DSN` — when provisioned; unset keeps tracking a no-op

**CI** (`.github/workflows/ci.yml`) — nothing to provision. Nine jobs run on Node 22:
`db` (migrate + RLS isolation/coverage suites), `web-tests`, `worker-tests`,
`package-tests-db` (ws-gateway, pos, forecast-run), `package-tests-redis` (realtime,
queue), `lint`, `web-build` (typecheck + `next build`), `services-typecheck`, and
`docker-build` (all three images). The DB-backed jobs use throwaway Postgres/Redis
service containers with dev-only credentials; `web-tests` and `web-build` set
placeholder `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL` values so module init succeeds.

**Local staging** (`docker-compose.staging.yml`) — variables come from
`.env.staging` (copy of `.env.staging.example`; dev defaults, no secrets). Inside the
compose network services address each other by name (`redis:6379`); the host-port
variables only exist to dodge collisions with other local stacks. The compose file
falls back to dev-only defaults for `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL`, which
`.env.staging.example` does not list — add them to your `.env.staging` if the rehearsal
should serve on a port other than 3000.
