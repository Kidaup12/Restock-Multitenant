-- Two gaps the isolation audit found, both narrow, neither a live leak.
--
-- 1. Tenant was never FORCEd.
--
-- The earlier force_rls_on_tenant_tables migration applied FORCE by looping over
-- tables carrying a `tenantId` column. Tenant has no such column — its `id` IS
-- the tenant id — so the loop skipped it, while that migration's own comment
-- claimed the loop "is the same rule the coverage census reads, so the two
-- cannot drift apart". The census authors already knew the rule is blind here
-- and patched it with a dedicated Tenant test; that test asserts the policy and
-- ENABLE, never FORCE. One blind spot, two places to remember it, remembered
-- once.
--
-- Not a leak today: wezesha_app does not own Tenant, so unforced RLS still
-- applies to it. The exposure is the one the original migration was written to
-- close — a restore makes the restoring role the owner, and an owner is exempt
-- from RLS that is merely enabled.
ALTER TABLE "Tenant" FORCE ROW LEVEL SECURITY;

-- 2. The managed platform's public roles hold full DML on every table.
--
-- anon and authenticated are granted SELECT/INSERT/UPDATE/DELETE/TRUNCATE on all
-- 42 public tables, including Session, Account and PlatformAdmin. Reads return
-- nothing because RLS is on and no policy admits them — verified against the
-- live database through an unauthenticated request. But that makes row-level
-- security the ONLY thing standing between a published anon key and the data,
-- and TRUNCATE is not subject to RLS at all.
--
-- This app never uses PostgREST: it connects as wezesha_app (RLS enforced) and
-- wezesha_service (BYPASSRLS, system paths only). Nothing here depends on these
-- grants, so removing them costs no behaviour and turns a single control into
-- two. Future tables are covered by the default-privilege revoke below.
-- Guarded per role: anon and authenticated are created by the managed platform
-- and do NOT exist in the docker Postgres that local development and CI run
-- against, where an unguarded REVOKE aborts the whole migration.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
    END IF;
  END LOOP;
END $$;
