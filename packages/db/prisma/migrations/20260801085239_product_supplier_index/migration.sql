-- CreateIndex
CREATE INDEX "Product_tenantId_supplierId_idx" ON "Product"("tenantId", "supplierId");
