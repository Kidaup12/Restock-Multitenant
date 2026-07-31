-- A feed slug is how the POS ingest endpoint decides which workspace a till is
-- posting for. The resolver looks it up on its own, so two workspaces holding
-- the same slug would let it pick whichever row it read first — one shop's
-- counter sales landing against another shop's history.
--
-- Nulls are unaffected: Postgres treats them as distinct, so every workspace
-- that has not set a custom slug stays as it is and keeps falling back to its
-- own tenant slug.
CREATE UNIQUE INDEX "TenantConfig_posFeedSlug_key" ON "TenantConfig"("posFeedSlug");
