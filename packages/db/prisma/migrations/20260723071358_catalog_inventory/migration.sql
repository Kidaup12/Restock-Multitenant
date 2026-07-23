-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shopifyProductId" TEXT,
    "shopifyVariantId" TEXT,
    "externalId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'shopify',
    "sku" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "vendor" TEXT,
    "productType" TEXT,
    "priceKes" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "costKes" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "imageUrl" TEXT,
    "currentStock" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "abcCategory" TEXT,
    "dailySalesRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lastSynced" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shopifyCreatedAt" TIMESTAMP(3),
    "supplierId" TEXT,
    "onOrder" INTEGER NOT NULL DEFAULT 0,
    "expectedArrivalAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "leadTimeDays" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "activeOverride" BOOLEAN NOT NULL DEFAULT false,
    "qbMatchedAt" TIMESTAMP(3),
    "notForSale" BOOLEAN NOT NULL DEFAULT false,
    "costSource" TEXT,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "leadTimeAvgDays" INTEGER NOT NULL DEFAULT 30,
    "leadTimeStdDays" INTEGER NOT NULL DEFAULT 7,
    "moq" INTEGER NOT NULL DEFAULT 1,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Location" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shopifyLocationId" TEXT,
    "externalId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'shopify',
    "name" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "locationType" TEXT,
    "roleStatus" TEXT,

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryLevel" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "onHand" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryLevel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventorySnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "onHand" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "InventorySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WarehouseLocationMap" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "warehouseName" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,

    CONSTRAINT "WarehouseLocationMap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IgnoreRule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IgnoreRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedFilter" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "page" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "query" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedFilter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Product_tenantId_idx" ON "Product"("tenantId");

-- CreateIndex
CREATE INDEX "Product_tenantId_source_idx" ON "Product"("tenantId", "source");

-- CreateIndex
CREATE INDEX "Product_tenantId_productType_idx" ON "Product"("tenantId", "productType");

-- CreateIndex
CREATE INDEX "Product_tenantId_vendor_idx" ON "Product"("tenantId", "vendor");

-- CreateIndex
CREATE INDEX "Product_tenantId_active_idx" ON "Product"("tenantId", "active");

-- CreateIndex
CREATE INDEX "Product_tenantId_notForSale_idx" ON "Product"("tenantId", "notForSale");

-- CreateIndex
CREATE UNIQUE INDEX "Product_tenantId_shopifyProductId_key" ON "Product"("tenantId", "shopifyProductId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_tenantId_source_externalId_key" ON "Product"("tenantId", "source", "externalId");

-- CreateIndex
CREATE INDEX "Supplier_tenantId_idx" ON "Supplier"("tenantId");

-- CreateIndex
CREATE INDEX "Location_tenantId_idx" ON "Location"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Location_tenantId_shopifyLocationId_key" ON "Location"("tenantId", "shopifyLocationId");

-- CreateIndex
CREATE UNIQUE INDEX "Location_tenantId_source_externalId_key" ON "Location"("tenantId", "source", "externalId");

-- CreateIndex
CREATE INDEX "InventoryLevel_tenantId_idx" ON "InventoryLevel"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryLevel_locationId_productId_key" ON "InventoryLevel"("locationId", "productId");

-- CreateIndex
CREATE INDEX "InventorySnapshot_tenantId_date_idx" ON "InventorySnapshot"("tenantId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "InventorySnapshot_productId_date_key" ON "InventorySnapshot"("productId", "date");

-- CreateIndex
CREATE INDEX "WarehouseLocationMap_tenantId_idx" ON "WarehouseLocationMap"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "WarehouseLocationMap_tenantId_warehouseName_key" ON "WarehouseLocationMap"("tenantId", "warehouseName");

-- CreateIndex
CREATE INDEX "IgnoreRule_tenantId_kind_idx" ON "IgnoreRule"("tenantId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "IgnoreRule_tenantId_kind_value_key" ON "IgnoreRule"("tenantId", "kind", "value");

-- CreateIndex
CREATE INDEX "SavedFilter_tenantId_userId_page_idx" ON "SavedFilter"("tenantId", "userId", "page");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLevel" ADD CONSTRAINT "InventoryLevel_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLevel" ADD CONSTRAINT "InventoryLevel_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventorySnapshot" ADD CONSTRAINT "InventorySnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventorySnapshot" ADD CONSTRAINT "InventorySnapshot_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarehouseLocationMap" ADD CONSTRAINT "WarehouseLocationMap_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarehouseLocationMap" ADD CONSTRAINT "WarehouseLocationMap_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IgnoreRule" ADD CONSTRAINT "IgnoreRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedFilter" ADD CONSTRAINT "SavedFilter_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security (hand-appended; prisma migrate does not manage policies).
-- Fail-closed: current_setting('app.tenant_id', true) is NULL when the GUC is
-- unset, so a query outside prismaForTenant matches no rows.
ALTER TABLE "Product" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Product"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "Supplier" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Supplier"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "Location" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Location"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "InventoryLevel" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "InventoryLevel"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "InventorySnapshot" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "InventorySnapshot"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "WarehouseLocationMap" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "WarehouseLocationMap"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "IgnoreRule" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "IgnoreRule"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "SavedFilter" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "SavedFilter"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
