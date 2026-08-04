-- AlterTable
ALTER TABLE "InventoryLevel" ADD COLUMN     "available" INTEGER;

-- Backfill from on-hand. The column is nullable with no default, deliberately:
-- NULL means "no available-aware sync has written this row yet", which a 0 could
-- not be distinguished from — and a NOT NULL DEFAULT 0 would read as "nothing is
-- sellable" for every product until the next successful sync. On a store whose
-- token is dead, that is not a moment away, it is indefinite.
--
-- The backfill means no row is actually NULL the day this lands, so the
-- sellableUnits() fallback is never exercised on existing data; it exists for
-- rows written afterwards by a path that forgets the column. Every product's
-- stock therefore reads exactly as it did before, and only starts moving once a
-- real sync reports what is committed.
UPDATE "InventoryLevel" SET "available" = "onHand" WHERE "available" IS NULL;
