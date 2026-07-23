-- Role bootstrap for Row-Level Security. Runs as the owner role (DIRECT_URL).
--
-- Guarded CREATE ROLE: roles are cluster-level, so the shadow-database replay
-- and any environment where ops pre-created the roles (production — see
-- prisma/sql/prod-roles.sql) must not fail on "role already exists".
-- The dev passwords below are for local docker/CI only; production roles are
-- created by ops with real credentials BEFORE the first migrate deploy.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wezesha_app') THEN
    CREATE ROLE wezesha_app LOGIN PASSWORD 'wezesha_app_dev';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wezesha_service') THEN
    CREATE ROLE wezesha_service LOGIN PASSWORD 'wezesha_service_dev' BYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO wezesha_app, wezesha_service;

-- Existing tables/sequences (none yet at this point, but keeps the migration
-- correct if it is ever replayed against a database that already has some).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wezesha_app, wezesha_service;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO wezesha_app, wezesha_service;

-- Every future table/sequence created by the migration owner inherits grants,
-- so per-table migrations only need ENABLE ROW LEVEL SECURITY + the policy.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wezesha_app, wezesha_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO wezesha_app, wezesha_service;
