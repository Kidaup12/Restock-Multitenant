-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "customCategory" TEXT;

-- CreateIndex
CREATE INDEX "Product_tenantId_customCategory_idx" ON "Product"("tenantId", "customCategory");
