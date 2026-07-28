-- Take the credential tables away from the request-time role.
--
-- Session, Account and Verification hold the most sensitive rows in the
-- database: session tokens, password hashes, OAuth access/refresh tokens, and
-- password-reset values. They carry no tenantId, so the RLS coverage census
-- skips them — and because the role bootstrap grants SELECT/INSERT/UPDATE/DELETE
-- on ALL tables (plus default privileges on future ones), `wezesha_app` — the
-- role every user request runs as — held full read and write on all three with
-- nothing in the database constraining it.
--
-- No application path needs that: authentication goes through the service
-- client (prismaAuth is prismaService, which is BYPASSRLS), and no tenant-scoped
-- query touches these tables. So the grant was pure attack surface. One
-- mis-built query in tenant-scoped code was the distance between a bug and every
-- live session token on the platform.
--
-- Belt and braces, because the two failures are independent:
--   REVOKE removes the privilege, and
--   ENABLE ROW LEVEL SECURITY with no policy denies all rows to any non-BYPASSRLS
--   role, so a future migration that re-grants (or another ALTER DEFAULT
--   PRIVILEGES sweep) does not silently reopen this.

REVOKE ALL PRIVILEGES ON TABLE "Session" FROM wezesha_app;
REVOKE ALL PRIVILEGES ON TABLE "Account" FROM wezesha_app;
REVOKE ALL PRIVILEGES ON TABLE "Verification" FROM wezesha_app;

ALTER TABLE "Session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Verification" ENABLE ROW LEVEL SECURITY;

-- User is different: the team screen legitimately reads member profiles through
-- the tenant-scoped client, which is what the tenant_visible_users policy is
-- for. That policy is FOR SELECT only, so writes already matched no rows —
-- revoking makes the intent explicit instead of resting on RLS's default deny.
REVOKE INSERT, UPDATE, DELETE ON TABLE "User" FROM wezesha_app;
