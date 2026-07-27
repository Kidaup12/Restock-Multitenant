-- DropIndex
DROP INDEX "Product_tenantId_shopifyProductId_key";

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "missingFromShopifyAt" TIMESTAMP(3),
ADD COLUMN     "publishedAt" TIMESTAMP(3),
ADD COLUMN     "shopifyStatus" TEXT NOT NULL DEFAULT 'active',
ADD COLUMN     "syncError" TEXT,
ADD COLUMN     "syncErrorAt" TIMESTAMP(3),
ADD COLUMN     "variantTitle" TEXT;

-- CreateIndex
CREATE INDEX "Product_tenantId_shopifyProductId_idx" ON "Product"("tenantId", "shopifyProductId");

-- CreateIndex
CREATE INDEX "Product_tenantId_shopifyStatus_idx" ON "Product"("tenantId", "shopifyStatus");

-- CreateIndex
CREATE INDEX "Product_tenantId_missingFromShopifyAt_idx" ON "Product"("tenantId", "missingFromShopifyAt");

-- CreateIndex
CREATE UNIQUE INDEX "Product_tenantId_shopifyVariantId_key" ON "Product"("tenantId", "shopifyVariantId");
