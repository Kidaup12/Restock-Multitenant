-- SalesHistory: one row per product-day PER BRANCH.
--
-- The old key allowed one row per (product, day, channel), so a day that traded
-- at two branches collapsed to a single row the sync refused to attribute — the
-- busiest days were exactly the ones that carried no location, which is why a
-- per-branch run rate could not be computed.
--
-- Widening only ADDS a column to the key, so every existing row stays valid and
-- nothing needs backfilling: historical rows keep whatever locationId they were
-- written with (null for the days that mixed branches).
--
-- Postgres treats NULLs as DISTINCT in a unique index, so this no longer stops
-- two unattributed rows for the same product-day existing. Both writers clear
-- the product-day before inserting it (shopify-sync.ts and packages/pos/ingest),
-- which is what keeps that from happening.
DROP INDEX "SalesHistory_productId_date_channel_key";

CREATE UNIQUE INDEX "SalesHistory_productId_date_channel_locationId_key"
  ON "SalesHistory"("productId", "date", "channel", "locationId");
