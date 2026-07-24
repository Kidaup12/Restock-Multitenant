-- CreateTable
CREATE TABLE "LocationClosure" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'closed',
    "note" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LocationClosure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LocationClosure_tenantId_date_idx" ON "LocationClosure"("tenantId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "LocationClosure_locationId_date_key" ON "LocationClosure"("locationId", "date");

-- AddForeignKey
ALTER TABLE "LocationClosure" ADD CONSTRAINT "LocationClosure_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationClosure" ADD CONSTRAINT "LocationClosure_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security (hand-appended; prisma migrate does not manage policies).
-- Fail-closed: current_setting('app.tenant_id', true) is NULL when the GUC is
-- unset, so a query outside prismaForTenant matches no rows.
ALTER TABLE "LocationClosure" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "LocationClosure"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
