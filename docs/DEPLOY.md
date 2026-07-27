# Deploying Wezesha Restock

Three pieces run in three places:

| Piece | Where | Why there |
|---|---|---|
| `apps/web` — Next.js app, server actions, webhook receiver | Vercel | Built for it; the webhook and OAuth callbacks need a stable public URL. |
| `apps/worker` — sync, forecast and email crons | Railway | Long-running process with schedules. Vercel functions cannot hold one. |
| `apps/ws-gateway` — realtime push | Railway | Holds open WebSocket connections. |
| Postgres | Supabase | Row-Level Security is the isolation guarantee, and it needs a real Postgres with custom roles. |
| Redis | Railway | Queue backing store for the worker. |

Deploy in the order below. Each step depends on the one above it.

---

## 1 · Supabase — the database

RLS is the enforcement boundary between tenants, and it only works if the app
connects as a **restricted role**. The default `postgres` connection string
bypasses every policy, so using it as `DATABASE_URL` silently disables tenant
isolation while everything still appears to work. That is the single most
important thing on this page.

1. Create the project. Keep the region close to the users.
2. Open the SQL editor and run `packages/db/prisma/sql/prod-roles.sql`, replacing
   both placeholders with strong secrets from the vault. **Run this before the
   first migration.** The role-bootstrap migration creates these roles with dev
   passwords when they are missing; pre-creating them makes it skip creation, so
   dev passwords never reach production.
3. Collect three connection strings:

   | Variable | Role | Used by |
   |---|---|---|
   | `DIRECT_URL` | `postgres` | Migrations only. Never by app code. |
   | `DATABASE_URL` | `wezesha_app` | Web. RLS applies. |
   | `SERVICE_DATABASE_URL` | `wezesha_service` | Worker. `BYPASSRLS`, scoped by explicit `tenantId` in every query. |

   Use the **session pooler** port for `DIRECT_URL` (migrations need a real
   session); the transaction pooler is fine for the other two.

4. Apply the schema from your machine, pointed at the new database:

   ```bash
   DIRECT_URL="<postgres-url>" DATABASE_URL="<app-role-url>" npm run migrate
   ```

   Migrations run over `DIRECT_URL`; `DATABASE_URL` only has to be present for
   the datasource to resolve.

5. Confirm isolation is actually on before anyone connects a store:

   ```sql
   select relname, relrowsecurity from pg_class
   where relnamespace = 'public'::regnamespace and relkind = 'r'
   order by relrowsecurity, relname;
   ```

   Every tenant-owned table must show `t`. A table showing `f` is a table where
   one shop can read another's rows.

## 2 · Railway — Redis, worker, gateway

1. Add a **Redis** service. Copy its private URL as `REDIS_URL`.
2. Add a service for the **worker** from the repo:
   - Root directory: repository root (it is an npm workspace monorepo).
   - Build: `npm ci`
   - Start: `npm run -w @wezesha/worker start`
3. Add a service for the **gateway**:
   - Build: `npm ci && npm run -w @wezesha/ws-gateway build`
   - Start: `npm run -w @wezesha/ws-gateway start`
   - Expose it publicly and note the URL — the web app needs it as
     `NEXT_PUBLIC_WS_URL` (use the `wss://` scheme).

Worker environment:

```
SERVICE_DATABASE_URL   from step 1
DIRECT_URL             from step 1
REDIS_URL              from Railway Redis
TOKEN_ENCRYPTION_KEY   openssl rand -base64 32   (must decode to exactly 32 bytes)
POS_FEED_SECRET        bearer token for the POS feed the worker fetches
RESEND_API_KEY         from Resend
EMAIL_FROM             e.g. Wezesha Restock <no-reply@yourdomain>
SENTRY_DSN             optional
```

The cron schedules (`FORECAST_CRON`, `SNAPSHOT_CRON`, `COST_CRONS`,
`EMAIL_CRONS`, `OPS_CRONS`, `POS_CRONS`) have working defaults. Set them only to
change timing.

## 3 · Vercel — the web app

Import the repo. Framework preset Next.js; leave the root directory at the
repository root so the workspace packages resolve.

Environment:

```
DATABASE_URL           the wezesha_app URL — NOT the postgres one
DIRECT_URL             from step 1
BETTER_AUTH_URL        the deployment's own public URL, exactly
BETTER_AUTH_SECRET     openssl rand -base64 32
NEXT_PUBLIC_WS_URL     wss://<gateway>.up.railway.app
ADMIN_EMAILS           comma-separated; who reaches the operator console
SHOPIFY_API_KEY        from the Shopify app
SHOPIFY_API_SECRET     from the Shopify app
SHOPIFY_APP_URL        the deployment's own public URL
TOKEN_ENCRYPTION_KEY   the SAME value as the worker
RESEND_API_KEY         from Resend
EMAIL_FROM             as above
```

`BETTER_AUTH_URL` must match the URL people actually visit. A mismatch fails
sign-in with "Invalid origin", which reads like a wrong password and costs an
afternoon.

`TOKEN_ENCRYPTION_KEY` must be identical in both places: the web app encrypts
Shopify access tokens and the worker decrypts them. Different values mean every
sync fails to authenticate.

## 4 · Shopify app

In the Partner dashboard set the app URL and the OAuth callback to the Vercel
URL, and give the app the read scopes for products, inventory, locations and
orders. The worker registers its own webhooks on the first successful sync — no
manual webhook setup.

## 5 · First run

1. Sign up through the deployed app to create the first workspace.
2. Connect a Shopify store from Settings.
3. Watch the worker logs for the first sync, then check the catalogue.

To put demo data in a non-production database instead:

```bash
DIRECT_URL="<postgres-url>" npm run seed
```

Never run the seed against a database with real tenants — it deletes the demo
tenant it owns and recreates it.

---

## Rotating a secret

`TOKEN_ENCRYPTION_KEY` cannot be rotated on its own: existing Shopify tokens are
encrypted with it and become unreadable. Rotating it means every connected store
reconnects. Rotate the others freely; redeploy both services after changing any
value shared between them.

## What this does not cover yet

Stated plainly so nobody discovers it in front of a client:

- **Currency is hard-coded to KES.** `Tenant.currency` exists but no display path
  reads it, so a non-Kenyan tenant sees Kenyan shillings on every screen.
- **Merchant-initiated install does not work.** The install route expects an
  existing session and workspace, so a merchant cannot install from the Shopify
  app listing — an operator creates the workspace first, then connects the store.
- **QuickBooks is referenced in the UI and not implemented.** The cost chain has
  a `qb` tier that nothing writes to.
- **POS connectors are generic.** The ingest endpoint accepts a feed; there is no
  connector for a specific till system.
- **No backup or restore drill has been run** against a hosted database.
