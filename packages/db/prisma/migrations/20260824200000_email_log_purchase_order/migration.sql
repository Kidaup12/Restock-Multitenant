-- Which order an email attempt belongs to.
--
-- The order screen had no way to ask: EmailLog carried no reference, so it
-- matched its own emails by finding the PO number inside the subject line. PO
-- numbers are unique among live orders but the ledger outlives them, so a
-- number freed and reissued attributed the earlier order's email to the new
-- one — a draft that had never been sent displayed "email went out" beside
-- "sent —", naming an address its supplier no longer had.
--
-- Nullable, and no foreign key on purpose: rows written before this column
-- existed have no order to point at, and the ledger has to survive the order
-- it describes being deleted.
ALTER TABLE "EmailLog" ADD COLUMN "purchaseOrderId" TEXT;

CREATE INDEX "EmailLog_purchaseOrderId_createdAt_idx"
  ON "EmailLog"("purchaseOrderId", "createdAt");
