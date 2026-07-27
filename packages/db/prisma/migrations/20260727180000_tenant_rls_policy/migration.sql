-- Tenant is the one tenant-owned table with no tenantId column — its own id IS
-- the tenant id. The RLS coverage census looks for that column, so Tenant was
-- never counted and never got a policy, and isolation there rested on the
-- application remembering to scope. The app reads Tenant through the
-- tenant-scoped client, so the policy below is what it was always missing.
--
-- It also unbreaks a hosted deployment. Managed Postgres (Supabase) enables RLS
-- on every table in the public schema, which turns a missing policy into
-- deny-all: SELECT returns zero rows rather than raising, so the app resolves no
-- workspace and reads as empty instead of broken. Locally RLS was simply off on
-- this table, so no test could see the difference.

ALTER TABLE "Tenant" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "Tenant";

CREATE POLICY tenant_isolation ON "Tenant"
  USING (id = current_setting('app.tenant_id', true))
  WITH CHECK (id = current_setting('app.tenant_id', true));
