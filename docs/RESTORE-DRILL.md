# Backup and restore drill

The database is the only thing here that cannot be rebuilt from the repository. Everything
else — the web app, the worker, the queue — is redeployed from a commit in minutes. A shop's
catalogue, sales history, costs, suppliers and purchase orders exist in exactly one place.

This is the procedure for proving we can get them back. It is written to be run, not read:
work through it start to finish and record the result at the bottom.

## What protects the data today

Two layers, and they fail differently, which is why both matter.

1. **The managed platform's own backups.** Daily snapshots, and point-in-time recovery on the
   paid tiers. Fast, complete, and the right tool for "the database is broken". Useless if the
   project itself is lost, suspended, or if someone deletes the wrong thing and nobody notices
   for a fortnight.
2. **A logical dump held somewhere else.** Slower and needs the roles recreated, but it is
   portable — it restores onto any Postgres, including a laptop. This is the copy that
   survives losing the account.

Confirm which backup tier the project is actually on before relying on layer 1. The plan
determines whether point-in-time recovery exists at all, and the answer is not visible from
the code.

## Before you start

- **`pg_dump` must match the server's major version.** The server is Postgres 17; a
  `pg_dump` from 16 refuses outright rather than producing a partial file. Check with
  `pg_dump --version`. If it disagrees, you do not need to install anything — run the
  matching client from a container and write the dump into the current directory:

  ```bash
  docker run --rm -v "$PWD:/out" postgres:17-alpine \
    pg_dump "$PROD_DATABASE_URL" --format=custom --no-owner --no-privileges --file=/out/wezesha.dump
  ```

  On Git Bash, prefix the command with `MSYS_NO_PATHCONV=1` or the container paths are
  rewritten to Windows ones and the dump lands somewhere you did not ask for.
- **Use a session-mode connection, not the transaction pooler.** Transaction pooling breaks
  `pg_dump`, usually with an error that looks like a permissions problem and is not.
- The connection string is in the deployment's environment, not in the repository.

## Taking the dump

Read-only against production. It holds no locks that block the app.

```bash
pg_dump "$PROD_DATABASE_URL" --format=custom --no-owner --no-privileges --file=wezesha-$(date +%Y%m%d).dump
```

`--no-owner` and `--no-privileges` matter: the managed platform's roles do not exist on a
restore target, and without these the restore fails on every `ALTER ... OWNER` line.

Note the file size. A dump that is suspiciously small is the failure this drill exists to
catch — check it before trusting it.

## Restoring into a scratch database

Never restore into production. Use a throwaway local database or a database branch.

```bash
createdb wezesha_restore_drill
```

The application connects as two restricted roles rather than as a superuser, and the dump
carries row-level security policies that reference them. Create them on the target first or
the policies restore against roles that do not exist:

```bash
psql -d wezesha_restore_drill -c "CREATE ROLE wezesha_app LOGIN PASSWORD 'restore-drill'; CREATE ROLE wezesha_service LOGIN PASSWORD 'restore-drill' BYPASSRLS;"
```

```bash
pg_restore --dbname=wezesha_restore_drill --no-owner --no-privileges --clean --if-exists wezesha-YYYYMMDD.dump
```

Expect harmless errors on `--clean` for objects that were not there to drop. Read them; do not
skim past a real failure sitting among them.

## Putting the grants back

`--no-privileges` is what stops the restore failing on every `ALTER ... OWNER`, and it also
drops the grants the application needs. Creating the roles is not enough: without this step
`wezesha_app` holds no table privileges at all, and the app answers `permission denied for
table Product` — which reads like a broken restore rather than a missing GRANT. These are the
same statements the roles-and-grants migration issues.

```bash
psql -d wezesha_restore_drill -c "
GRANT USAGE ON SCHEMA public TO wezesha_app, wezesha_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wezesha_app, wezesha_service;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO wezesha_app, wezesha_service;"
```

## Proving the restore is good

A restore that completes is not a restore that worked. Check all four.

**1. Every table came across.** Compare row counts against production, table by table. A dump
taken through a transaction pooler can silently produce empty tables.

```bash
psql -d wezesha_restore_drill -c "select relname, n_live_tup from pg_stat_user_tables order by relname;"
```

**2. Row-level security survived.** This is the control that keeps one shop out of another's
data, and it is carried by the dump rather than by the application. Every tenant table should
report security enabled and forced, with a policy attached:

```bash
psql -d wezesha_restore_drill -c "select relname, relrowsecurity, relforcerowsecurity, (select count(*) from pg_policies p where p.tablename = c.relname) as policies from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by relname;"
```

A restored database with RLS missing is worse than no restore, because it looks like it worked.

The columns prove the policies are attached; this proves they bite. Connect as the restricted
role, not as the superuser — a superuser bypasses RLS and will read every row either way, so
running this as `postgres` tells you nothing:

```bash
psql -U wezesha_app -d wezesha_restore_drill -c 'select count(*) from "Product";'          # must be 0
psql -U wezesha_app -d wezesha_restore_drill -c "set app.tenant_id = '<a real tenant id>'; select count(*) from \"Product\";"   # must be > 0
```

Read the tenant id as the superuser first. Asking for it through the restricted role with no
context set returns nothing, so the second query silently checks an empty string and reports 0
— a pass that looks like a failure, or worse, the reverse.

Auth-side tables (`Account`, `PlatformAdmin`, `Session`, `User`, `Verification`) and
`WebhookEvent` carry no `tenantId` and are expected to show RLS unforced or absent. Every other
table should be enabled *and* forced.

**3. The migration ledger matches the repository.** If the restore is a migration or two
behind, the application will fail on a column that is not there:

```bash
psql -d wezesha_restore_drill -c "select migration_name from _prisma_migrations order by finished_at desc limit 5;"
```

**4. The application actually runs against it.** Point a local web app at the restored database
and open the dashboard, the buy list and one product. Reading rows in `psql` proves the data
moved; opening the buy list proves it is coherent.

## Recording the result

A drill nobody wrote down did not happen. Add a line here each time:

| date | dump size | restore time | verified by | notes |
|---|---|---|---|---|
| 2026-08-25 | 807 KB | under a minute | dev | **Rehearsal, dev database as the source — not production.** Restored onto a throwaway Postgres 17 container. All four checks passed: row counts matched exactly table by table (3,816 sales rows), 37 tenant tables came back RLS-enabled and forced, the ledger matched the repository, and the restricted role read 0 rows without a tenant context and 30 with one. Found two holes in this document and fixed them: the dump needs a version-matched client (now a container one-liner) and the restore needs the grants re-issued, without which the app cannot read a single table. |

The production-sourced drill is still outstanding — it needs the deployment's connection
string, which lives in the environment and not with whoever is reading this. Everything except
that first command is now rehearsed, so it should be uneventful.

## When it is for real

Recovering production is a different decision from this drill and should not be improvised.
Prefer the platform's point-in-time recovery — it is faster and loses less. Reach for a logical
restore when the project itself is gone, or when only part of the data needs recovering. Either
way: take a fresh dump of the broken state first, so a bad recovery is not the only remaining
version.

See also `INCIDENT-RESPONSE.md`.
