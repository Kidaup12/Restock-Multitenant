# @wezesha/db

Prisma schema, migrations, and the tenant-scoped database clients. Every other
workspace reaches the database through this package — the raw `PrismaClient` is
never exported.

## Connection model

Three roles, three URLs (see `.env.example`):

| Env var | Role | Used for |
|---|---|---|
| `DATABASE_URL` | `wezesha_app` (RLS enforced) | all request-path queries, via `prismaForTenant` |
| `SERVICE_DATABASE_URL` | `wezesha_service` (BYPASSRLS) | crons, webhooks, auth bootstrap, offline scripts |
| `DIRECT_URL` | owner (`postgres`) | `prisma migrate` only |

Row-Level Security is on from the first migration: every tenant table carries a
`tenant_isolation` policy keyed on the `app.tenant_id` GUC. `prismaForTenant`
sets the GUC transaction-locally with each operation; an unset GUC matches no
rows, so a missed conversion fails closed (empty page, never a cross-tenant leak).

Pooler note: the per-operation array-form `$transaction` pins both statements to
one backend, which is what makes the GUC safe under transaction-mode pooling in
production. It also means **one connection per operation**, so a batch of N reads
issued together (a `Promise.all`) asks the pool for N connections and everything
behind the slowest one times out where the pool is smaller. Run batches through
`prismaForTenantTx`, which holds a single connection for the whole callback and
takes the transaction limits — a nightly batch needs a `timeout` well above the
5s default. Size `connection_limit` to the process: 1 for serverless, a real pool
for the long-lived worker (`deploy/ENVIRONMENT.md`).

## Workflow

```
docker compose up -d db          # repo root; localhost:5434
cp .env.example .env             # this package
npm run -w @wezesha/db db:migrate:deploy
npm run -w @wezesha/db db:generate
npm run -w @wezesha/db test
```

New tenant table checklist (enforced by the coverage test in CI):
1. Model with `tenantId` + `@@index([tenantId])`.
2. `prisma migrate dev --create-only`, then append to the migration:
   `ALTER TABLE ... ENABLE ROW LEVEL SECURITY;` + the `tenant_isolation` policy.
3. Extend the two-tenant seed fixture; the isolation suite picks the model up
   automatically from the Prisma DMMF.

## Platform admins

Who may reach the operator console lives in the `PlatformAdmin` table, not in an
env var. The table is revoked from `wezesha_app` and has RLS enabled with no
policy, so the role every user request runs as cannot read it, let alone grant
itself a row — see `tests/platform-admin-lock.test.ts`.

Seed the first one (idempotent; a revoked admin is restored and reported as
such):

```
npm run bootstrap:admin -- someone@example.com
```

It refuses an account that signs in with an email code only: platform admins
re-enter their password before every privileged action, and an account with no
password would reach a console where every mutation refuses it.

Production roles are pre-created by ops (`prisma/sql/prod-roles.sql`, run once
as `postgres` before the first `migrate deploy`) — the role-bootstrap
migration's guards then skip creation.
