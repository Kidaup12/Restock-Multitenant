-- The run rate divides by in-stock days, which means reading every day a
-- product was out. That read asks for onHand <= 0 over a tenant's whole date
-- range, and the existing (tenantId, date) index matches the range but not the
-- predicate — so Postgres scans every snapshot in the window and discards the
-- ~85% that are in stock. Measured: fine on a 30-product catalogue, about a
-- second and a half at three thousand, which is a page load.
--
-- A partial index stores only the rows the query actually wants, so the scan is
-- matched rows rather than filtered ones.
--
-- Prisma's schema language cannot express a partial index, so this migration is
-- the only definition. Do not expect it in schema.prisma, and do not let a
-- schema diff drop it.

CREATE INDEX IF NOT EXISTS "InventorySnapshot_tenantId_date_stockout_idx"
  ON "InventorySnapshot" ("tenantId", "date")
  WHERE "onHand" <= 0;
