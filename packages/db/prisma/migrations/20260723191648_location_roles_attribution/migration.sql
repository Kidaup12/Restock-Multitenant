-- AlterTable
ALTER TABLE "InventoryLevel" ADD COLUMN     "incoming" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "SalesHistory" ADD COLUMN     "locationId" TEXT;

-- CreateIndex
CREATE INDEX "SalesHistory_tenantId_locationId_idx" ON "SalesHistory"("tenantId", "locationId");

-- AddForeignKey
ALTER TABLE "SalesHistory" ADD CONSTRAINT "SalesHistory_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
