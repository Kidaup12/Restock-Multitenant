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
| `DATABASE_URL` | `packages/db/prisma/schema.prisma` (datasource `url`) | any consumer of `@wezesha/db` (web, once wired); Prisma CLI | Vercel (web); CI; local `.env` | url (secret) | `postgresql://wezesha_app:wezesha_app_dev@localhost:5434/wezesha` |
| `SERVICE_DATABASE_URL` | `packages/db/src/client.ts` (`prismaService`) | any consumer of `@wezesha/db` needing the BYPASSRLS client | Vercel (web); CI; local `.env` | url (secret) | `postgresql://wezesha_service:wezesha_service_dev@localhost:5434/wezesha` |
| `DIRECT_URL` | `packages/db/prisma/schema.prisma` (datasource `directUrl`) | Prisma CLI only (`migrate deploy`); RLS test suite | wherever migrations run (ops machine or CI); never a runtime platform | url (secret) | `postgresql://postgres:postgres@localhost:5434/wezesha` |
| `PORT` | `apps/ws-gateway/src/index.ts` | ws-gateway | Railway (injected automatically) | config | `8081` |
| `REDIS_URL` | `apps/ws-gateway/src/index.ts`; `apps/worker/src/index.ts` | ws-gateway, worker | Railway (reference to the Redis service, see below) | url (secret) | `redis://localhost:6380` |
| `WS_DEV_TOKEN` | `apps/ws-gateway/src/index.ts` | ws-gateway | Railway | secret | unset (gateway rejects all connections when unset — fail closed) |
| `NODE_ENV` | `apps/web/components/sw-register.tsx`; `packages/db/src/client.ts` | web; db consumers | set by Vercel/Next and the Dockerfiles automatically — never set by hand | config | `development` |
| `SHOPIFY_API_KEY` | `apps/web/lib/shopify/env.ts` | web | Vercel | secret | unset (Shopify flows 500 with a clear message) |
| `SHOPIFY_API_SECRET` | `apps/web/lib/shopify/env.ts`; `apps/web/app/api/webhooks/shopify/route.ts` | web | Vercel | secret | unset |
| `SHOPIFY_APP_URL` | `apps/web/lib/shopify/env.ts`; `apps/worker/src/shopify-sync.ts` | web (OAuth redirect URI); worker (webhook registration) | Vercel; Railway | url (config) | `http://localhost:3000` (OAuth/webhooks need a public tunnel locally) |
| `TOKEN_ENCRYPTION_KEY` | `packages/shopify/src/crypto.ts` (via web callback + worker sync) | web, worker | Vercel; Railway — SAME value on both | secret | unset (token store/read throws) |
| `EMAIL_CRONS` | `apps/worker/src/index.ts` | worker | Railway (`1` in environments that should send scheduled email) | config | unset (no cron schedules registered — dev/CI stay quiet) |
| `ADMIN_EMAILS` | `apps/web/lib/admin/gate.ts` | web | Vercel | config (sensitive — names the operator accounts) | unset (the `/admin` console 404s for everyone — fail closed) |

Notes:

- **`WS_DEV_TOKEN` is interim.** It backs the dev auth stub
  (`apps/ws-gateway/src/auth.ts`, token format `<secret>:<tenantId>`). The auth branch
  replaces this seam with session-backed socket auth; expect this variable to be
  retired then.
- **web reads no other env today.** On the current `develop`, `apps/web` does not yet
  import `@wezesha/db`, so the three DB URLs are listed for web as *forthcoming* — set
  them when the web app wires the db package (the auth branch does this).
- **web also needs `REDIS_URL`** since the Shopify branch: OAuth callback, sync-now,
  and webhook routes enqueue worker jobs (`apps/web/lib/shopify/queue.ts`).
- **worker needs the DB URLs** since the Shopify branch: the sync writes through the
  service client, so set `SERVICE_DATABASE_URL` + `DATABASE_URL` (client construction)
  alongside `REDIS_URL`, `TOKEN_ENCRYPTION_KEY`, and `SHOPIFY_APP_URL` on Railway.
- **`TOKEN_ENCRYPTION_KEY` is one key, two services.** The web callback encrypts the
  store token; the worker decrypts it per sync. Rotating it invalidates stored
  connections (stores must reconnect) — treat rotation as an offboarding-grade event.
- **Shopify app credentials** come from the app entry in the Shopify Dev Dashboard.
  The app's redirect URL allow-list must contain `<SHOPIFY_APP_URL>/api/shopify/callback`
  per environment.

## The three-URL database model (Supabase)

Three connections, three privilege levels — the rationale lives in
`packages/db/src/client.ts` and `packages/db/prisma/sql/prod-roles.sql`:

| Variable | Postgres role | Privilege | Route |
|---|---|---|---|
| `DATABASE_URL` | `wezesha_app` | RLS **enforced** | pooled (Supavisor, transaction mode) |
| `SERVICE_DATABASE_URL` | `wezesha_service` | `BYPASSRLS` | pooled (Supavisor, transaction mode) |
| `DIRECT_URL` | `postgres` (owner) | full — migrations only | direct to the database |

Production URL shapes (substitute `<project-ref>`, `<region>`, and vault passwords):

```
DATABASE_URL=postgresql://wezesha_app.<project-ref>:<app-role-password>@aws-0-<region>.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1
SERVICE_DATABASE_URL=postgresql://wezesha_service.<project-ref>:<service-role-password>@aws-0-<region>.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1
DIRECT_URL=postgresql://postgres:<owner-password>@db.<project-ref>.supabase.co:5432/postgres
```

Supabase specifics that are easy to get wrong:

- **Pooled = port 6543, transaction mode.** `pgbouncer=true` disables Prisma prepared
  statements (transaction pooling breaks them); `connection_limit=1` keeps serverless
  instances from hoarding pooled connections. Transaction-mode pooling is exactly what
  the tenant client is designed for — the `app.tenant_id` GUC is set
  transaction-locally in the same transaction as each query (`packages/db/src/client.ts`),
  so nothing leaks across recycled connections.
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
| `REDIS_URL` | prod Redis | staging Redis — never prod | local |
| `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` | prod app | dev app — never the prod app | dev app |
| `SHOPIFY_APP_URL` | prod origin | preview origin | tunnel origin |
| `TOKEN_ENCRYPTION_KEY` | prod key (= worker's) | preview key (= staging worker's) | local key |
| AUTH vars (below) | prod values | preview values | local |

`develop` deploys as Preview (Production Branch is `main`), so Preview values are what
`develop` runs with. Point Preview at a separate Supabase project or branch database —
previews must never hold prod credentials.

**Railway (ws-gateway)** — service variables:

- `REDIS_URL` = `${{Redis.REDIS_URL}}` (service reference to the Redis service; use the
  private-network variant if available so traffic stays inside the project)
- `WS_DEV_TOKEN` = generated secret (vault)
- `PORT` — do not set; Railway injects it and the app reads it

**Railway (worker)** — service variables:

- `REDIS_URL` = `${{Redis.REDIS_URL}}` (same reference)
- `DATABASE_URL`, `SERVICE_DATABASE_URL` — same DB values as web for the environment
- `TOKEN_ENCRYPTION_KEY` — same value as web for the environment
- `SHOPIFY_APP_URL` — the web origin for the environment (webhook registration)

**CI** (`.github/workflows/ci.yml`, db job) — already wired to the throwaway Postgres
service container with dev-only credentials; nothing to provision.

**Local staging** (`docker-compose.staging.yml`) — variables come from
`.env.staging` (copy of `.env.staging.example`; dev defaults, no secrets). Inside the
compose network services address each other by name (`redis:6379`); the host-port
variables only exist to dodge collisions with other local stacks.

## AUTH (placeholder — lands with the auth branch)

The in-progress auth branch adds Better Auth. Reserve this section; fill in exact
names/read-sites when that branch merges. Expected shape:

| Variable | Service(s) | Set on | Class | Notes |
|---|---|---|---|---|
| `BETTER_AUTH_SECRET` | web | Vercel | secret | signing secret (Better Auth reads it from env by convention); generate per environment, never shared between preview and prod |
| `BETTER_AUTH_URL` | web | Vercel | url (config) | canonical app URL per environment |
| (email provider creds) | web | Vercel | secret | the branch ships a console-log email seam (`apps/web/lib/email.ts`); real provider creds arrive when one is wired |
| (gateway session auth) | ws-gateway | Railway | — | the branch disables `WS_DEV_TOKEN` when `NODE_ENV=production` and authorizes sockets against sessions instead — expect gateway DB access and its own env additions |
