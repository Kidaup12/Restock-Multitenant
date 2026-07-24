-- AlterTable
ALTER TABLE "BacktestRun" ADD COLUMN     "abcClass" TEXT,
ADD COLUMN     "happenedUnits" DOUBLE PRECISION,
ADD COLUMN     "leans" TEXT,
ADD COLUMN     "method" TEXT,
ADD COLUMN     "saidUnits" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "Prediction" ADD COLUMN     "borrowedFromProductId" TEXT,
ADD COLUMN     "coldStart" TEXT,
ADD COLUMN     "confidenceWord" TEXT;

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN     "forecastChampions" JSONB;

-- CreateTable
CREATE TABLE "OwnerPrior" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scopeValue" TEXT NOT NULL,
    "expectedUnits" DOUBLE PRECISION,
    "multiplier" DOUBLE PRECISION,
    "proxyProductId" TEXT,
    "weeks" INTEGER NOT NULL DEFAULT 4,
    "note" TEXT,
    "createdByUserId" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "OwnerPrior_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OwnerPrior_tenantId_scope_scopeValue_idx" ON "OwnerPrior"("tenantId", "scope", "scopeValue");

-- CreateIndex
CREATE INDEX "OwnerPrior_tenantId_revokedAt_idx" ON "OwnerPrior"("tenantId", "revokedAt");

-- AddForeignKey
ALTER TABLE "OwnerPrior" ADD CONSTRAINT "OwnerPrior_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security (hand-appended; prisma migrate does not manage policies).
-- Fail-closed: current_setting('app.tenant_id', true) is NULL when the GUC is
-- unset, so a query outside prismaForTenant matches no rows.
ALTER TABLE "OwnerPrior" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "OwnerPrior"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
