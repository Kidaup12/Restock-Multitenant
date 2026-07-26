-- CreateTable
CREATE TABLE "ForecastRecommendation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "runDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recommendedQty" DOUBLE PRECISION NOT NULL,
    "finalForecast30d" DOUBLE PRECISION NOT NULL,
    "daysUntilStockout" INTEGER NOT NULL,
    "urgency" TEXT NOT NULL,
    "confidenceWord" TEXT,
    "coldStart" TEXT,
    "onHandAtRun" DOUBLE PRECISION NOT NULL,
    "abcClass" TEXT,

    CONSTRAINT "ForecastRecommendation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ForecastRecommendation_tenantId_runDate_idx" ON "ForecastRecommendation"("tenantId", "runDate");

-- CreateIndex
CREATE INDEX "ForecastRecommendation_tenantId_productId_runDate_idx" ON "ForecastRecommendation"("tenantId", "productId", "runDate");

-- CreateIndex
CREATE UNIQUE INDEX "ForecastRecommendation_tenantId_productId_runDate_key" ON "ForecastRecommendation"("tenantId", "productId", "runDate");

-- AddForeignKey
ALTER TABLE "ForecastRecommendation" ADD CONSTRAINT "ForecastRecommendation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForecastRecommendation" ADD CONSTRAINT "ForecastRecommendation_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security (hand-appended; prisma migrate does not manage policies).
-- Fail-closed: current_setting('app.tenant_id', true) is NULL when the GUC is
-- unset, so a query outside prismaForTenant matches no rows.
ALTER TABLE "ForecastRecommendation" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ForecastRecommendation"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
