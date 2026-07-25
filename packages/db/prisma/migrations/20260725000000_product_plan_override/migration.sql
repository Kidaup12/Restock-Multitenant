-- CreateTable
CREATE TABLE "ProductPlanOverride" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "note" TEXT,
    "createdByUserId" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductPlanOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductPlanOverride_tenantId_idx" ON "ProductPlanOverride"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductPlanOverride_tenantId_productId_key" ON "ProductPlanOverride"("tenantId", "productId");

-- AddForeignKey
ALTER TABLE "ProductPlanOverride" ADD CONSTRAINT "ProductPlanOverride_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security (hand-appended; prisma migrate does not manage policies).
-- Fail-closed: current_setting('app.tenant_id', true) is NULL when the GUC is
-- unset, so a query outside prismaForTenant matches no rows.
ALTER TABLE "ProductPlanOverride" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ProductPlanOverride"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
