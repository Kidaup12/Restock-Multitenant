-- Split "where have we read up to" from "when did anything actually arrive".
-- The cursor answered both, and it advances after every run whether or not a
-- single row came back — so a connected store that has sent nothing for weeks
-- reported a sync minutes old and the shop was never told its figures had
-- stopped moving.
ALTER TABLE "IngestCursor" ADD COLUMN "dataAt" TIMESTAMP(3);

-- Backfill from the cursor rather than leaving null. Null means "this resource
-- has never delivered anything", which for an existing row is a claim we cannot
-- make: it would flag every workspace the moment this deploys. Seeding from the
-- cursor starts the staleness clock at the deploy instead, so a store that is
-- genuinely silent surfaces within the day and a healthy one never does.
UPDATE "IngestCursor" SET "dataAt" = "cursor";
