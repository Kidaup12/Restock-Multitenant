-- FORCE row-level security on every tenant table.
--
-- ENABLE alone exempts the table's OWNER from its own policies. Isolation has
-- therefore been resting on an accident of deployment: the app connects as
-- `wezesha_app`, which happens not to own anything. Nothing asserts that, and a
-- restore is exactly where it stops being true — whoever runs pg_restore owns
-- what it recreates, so a database rebuilt by the app role would come back with
-- every policy silently inert and look perfectly healthy.
--
-- FORCE closes that. It does NOT affect:
--   - `wezesha_service` (BYPASSRLS — the worker's system-derivation client),
--   - `postgres` (BYPASSRLS on Supabase and superuser locally, so migrations
--     and this file itself still run),
-- because BYPASSRLS outranks FORCE. The only role it binds is the one that is
-- supposed to be bound.
--
-- Applied by loop rather than a list of 33 names: the set is "every table
-- carrying tenantId", which is the same rule the coverage census reads, so the
-- two cannot drift apart.
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relrowsecurity
      AND EXISTS (
        SELECT 1 FROM information_schema.columns col
        WHERE col.table_schema = 'public'
          AND col.table_name = c.relname
          AND col.column_name = 'tenantId'
      )
  LOOP
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;
