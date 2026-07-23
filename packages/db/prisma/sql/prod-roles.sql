-- Production role bootstrap — run ONCE by ops in the production database
-- BEFORE the first `prisma migrate deploy`. Never executed automatically.
--
-- The role-bootstrap migration creates these roles with dev passwords when they
-- don't exist (local docker, CI). Pre-creating them here with real credentials
-- makes that migration's guards skip creation, so dev passwords never reach
-- production. Replace both placeholders with strong secrets from the vault.
--
-- On Supabase, run as the `postgres` role (it carries the grants needed for
-- CREATE ROLE ... BYPASSRLS).

CREATE ROLE wezesha_app LOGIN PASSWORD '<app-role-password-from-vault>';
CREATE ROLE wezesha_service LOGIN PASSWORD '<service-role-password-from-vault>' BYPASSRLS;
