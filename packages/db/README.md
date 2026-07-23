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
production. Size `connection_limit` accordingly and prefer `prismaForTenantTx`
for routes that run many queries.

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

Production roles are pre-created by ops (see `prisma/sql/prod-roles.sql` once it
lands) — the role-bootstrap migration's guards then skip creation.
