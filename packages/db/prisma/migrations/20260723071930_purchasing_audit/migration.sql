-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "poNumberFloor" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "predictionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "shopifyDraftOrderId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "skipReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purchaseOrderId" TEXT,
    "productId" TEXT,
    "orderedQty" INTEGER,
    "orderedAt" TIMESTAMP(3),
    "expectedArrivalAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "stockAtOrder" DOUBLE PRECISION,
    "sawEnroute" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'app',
    "qbDocRef" TEXT,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "supplierId" TEXT,
    "vendor" TEXT,
    "poNumber" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "subtotalKes" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdByName" TEXT,
    "qbConfirmedAt" TIMESTAMP(3),
    "qbDocRef" TEXT,
    "qbSuggestion" TEXT,
    "needsAttention" BOOLEAN NOT NULL DEFAULT false,
    "receivedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledByName" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedByName" TEXT,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderLine" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitCostKes" DOUBLE PRECISION NOT NULL,
    "lineTotalKes" DOUBLE PRECISION NOT NULL,
    "recommendedQty" INTEGER,

    CONSTRAINT "PurchaseOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DistributionPlan" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT,
    "fromLocationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "coverDays" INTEGER NOT NULL DEFAULT 14,
    "windowDays" INTEGER NOT NULL DEFAULT 90,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "DistributionPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DistributionPlanLine" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "toLocationId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "fromOnHand" INTEGER NOT NULL DEFAULT 0,
    "toOnHand" INTEGER NOT NULL DEFAULT 0,
    "toRunRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "toDaysCoverBefore" DOUBLE PRECISION,
    "toDaysCoverAfter" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'planned',

    CONSTRAINT "DistributionPlanLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorName" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Order_tenantId_status_idx" ON "Order"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Order_tenantId_productId_status_idx" ON "Order"("tenantId", "productId", "status");

-- CreateIndex
CREATE INDEX "Order_tenantId_qbDocRef_idx" ON "Order"("tenantId", "qbDocRef");

-- CreateIndex
CREATE INDEX "PurchaseOrder_tenantId_idx" ON "PurchaseOrder"("tenantId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_tenantId_status_idx" ON "PurchaseOrder"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_tenantId_poNumber_key" ON "PurchaseOrder"("tenantId", "poNumber");

-- CreateIndex
CREATE INDEX "PurchaseOrderLine_purchaseOrderId_idx" ON "PurchaseOrderLine"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "PurchaseOrderLine_tenantId_idx" ON "PurchaseOrderLine"("tenantId");

-- CreateIndex
CREATE INDEX "DistributionPlan_tenantId_idx" ON "DistributionPlan"("tenantId");

-- CreateIndex
CREATE INDEX "DistributionPlan_tenantId_status_idx" ON "DistributionPlan"("tenantId", "status");

-- CreateIndex
CREATE INDEX "DistributionPlanLine_planId_idx" ON "DistributionPlanLine"("planId");

-- CreateIndex
CREATE INDEX "DistributionPlanLine_tenantId_idx" ON "DistributionPlanLine"("tenantId");

-- CreateIndex
CREATE INDEX "AuditEvent_tenantId_createdAt_idx" ON "AuditEvent"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_tenantId_entity_entityId_idx" ON "AuditEvent"("tenantId", "entity", "entityId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_predictionId_fkey" FOREIGN KEY ("predictionId") REFERENCES "Prediction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DistributionPlan" ADD CONSTRAINT "DistributionPlan_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DistributionPlan" ADD CONSTRAINT "DistributionPlan_fromLocationId_fkey" FOREIGN KEY ("fromLocationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DistributionPlanLine" ADD CONSTRAINT "DistributionPlanLine_planId_fkey" FOREIGN KEY ("planId") REFERENCES "DistributionPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DistributionPlanLine" ADD CONSTRAINT "DistributionPlanLine_toLocationId_fkey" FOREIGN KEY ("toLocationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security (hand-appended; prisma migrate does not manage policies).
-- Fail-closed: current_setting('app.tenant_id', true) is NULL when the GUC is
-- unset, so a query outside prismaForTenant matches no rows.
ALTER TABLE "Order" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Order"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "PurchaseOrder" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PurchaseOrder"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "PurchaseOrderLine" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PurchaseOrderLine"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "DistributionPlan" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "DistributionPlan"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "DistributionPlanLine" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "DistributionPlanLine"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "AuditEvent" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AuditEvent"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
