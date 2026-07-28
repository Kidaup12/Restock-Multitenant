-- User is a global table: a person can belong to several workspaces, so it
-- carries no tenantId and the coverage census skips it. Managed Postgres turns
-- that omission into deny-all, and the team screen reads member profiles
-- through the tenant-scoped client — so it saw its own memberships attached to
-- nobody and failed on the missing person.
--
-- Visibility is exactly co-membership: you can see a user when they belong to
-- the workspace you are currently scoped to. Not the whole table, and not only
-- yourself. Sessions, accounts and verifications stay closed to this role —
-- auth reads them through the service client and nothing else should see them.

ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_visible_users ON "User";

CREATE POLICY tenant_visible_users ON "User"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "Membership" m
       WHERE m."userId" = "User".id
         AND m."tenantId" = current_setting('app.tenant_id', true)
    )
  );
