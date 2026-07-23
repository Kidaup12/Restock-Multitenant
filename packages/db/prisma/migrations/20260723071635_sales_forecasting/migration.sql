-- CreateTable
CREATE TABLE "SalesHistory" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "revenueKes" DOUBLE PRECISION NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'shopify',

    CONSTRAINT "SalesHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosSale" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "reference" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "salesAgent" TEXT,
    "warehouse" TEXT,
    "customer" TEXT,
    "saleStatus" TEXT,
    "paymentStatus" TEXT,
    "grandTotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "channel" TEXT NOT NULL DEFAULT 'physical',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosSale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosSaleLine" (
    "id" TEXT NOT NULL,
    "posSaleId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "subtotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "productId" TEXT,

    CONSTRAINT "PosSaleLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonthlyContext" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "marketingBudget" DOUBLE PRECISION,
    "promotions" TEXT,
    "seasonalExpectation" TEXT,
    "cashFlow" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonthlyContext_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Promo" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'all',
    "scopeValue" TEXT,
    "discountPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "promoType" TEXT NOT NULL DEFAULT 'flash',
    "channel" TEXT NOT NULL DEFAULT 'all',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Promo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Prediction" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "runDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "layer1Forecast30d" DOUBLE PRECISION NOT NULL,
    "layer1Confidence" DOUBLE PRECISION NOT NULL,
    "layer2Adjustment" DOUBLE PRECISION NOT NULL,
    "finalForecast30d" DOUBLE PRECISION NOT NULL,
    "daysUntilStockout" INTEGER NOT NULL,
    "recommendedQty" DOUBLE PRECISION NOT NULL,
    "safetyStock" DOUBLE PRECISION NOT NULL,
    "reorderPoint" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "reasoning" TEXT NOT NULL,
    "urgency" TEXT NOT NULL,
    "signals" TEXT NOT NULL,
    "forecastRunId" TEXT NOT NULL,
    "regime" TEXT,

    CONSTRAINT "Prediction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BacktestRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mae" DOUBLE PRECISION NOT NULL,
    "bias" DOUBLE PRECISION NOT NULL,
    "mape" DOUBLE PRECISION,
    "sampleSize" INTEGER NOT NULL,
    "tag" TEXT,

    CONSTRAINT "BacktestRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpotCheck" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "weekKey" TEXT NOT NULL,
    "systemQty" DOUBLE PRECISION NOT NULL,
    "countedQty" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "countedAt" TIMESTAMP(3),

    CONSTRAINT "SpotCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SalesHistory_tenantId_date_idx" ON "SalesHistory"("tenantId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "SalesHistory_productId_date_channel_key" ON "SalesHistory"("productId", "date", "channel");

-- CreateIndex
CREATE INDEX "PosSale_tenantId_date_idx" ON "PosSale"("tenantId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "PosSale_tenantId_externalId_key" ON "PosSale"("tenantId", "externalId");

-- CreateIndex
CREATE INDEX "PosSaleLine_tenantId_productId_idx" ON "PosSaleLine"("tenantId", "productId");

-- CreateIndex
CREATE INDEX "PosSaleLine_posSaleId_idx" ON "PosSaleLine"("posSaleId");

-- CreateIndex
CREATE UNIQUE INDEX "MonthlyContext_tenantId_month_key" ON "MonthlyContext"("tenantId", "month");

-- CreateIndex
CREATE INDEX "Promo_tenantId_startDate_idx" ON "Promo"("tenantId", "startDate");

-- CreateIndex
CREATE INDEX "Prediction_tenantId_runDate_idx" ON "Prediction"("tenantId", "runDate");

-- CreateIndex
CREATE INDEX "Prediction_productId_runDate_idx" ON "Prediction"("productId", "runDate");

-- CreateIndex
CREATE INDEX "Prediction_tenantId_productId_runDate_idx" ON "Prediction"("tenantId", "productId", "runDate");

-- CreateIndex
CREATE INDEX "Prediction_tenantId_forecastRunId_idx" ON "Prediction"("tenantId", "forecastRunId");

-- CreateIndex
CREATE INDEX "BacktestRun_tenantId_runDate_idx" ON "BacktestRun"("tenantId", "runDate");

-- CreateIndex
CREATE INDEX "SpotCheck_tenantId_weekKey_idx" ON "SpotCheck"("tenantId", "weekKey");

-- AddForeignKey
ALTER TABLE "SalesHistory" ADD CONSTRAINT "SalesHistory_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesHistory" ADD CONSTRAINT "SalesHistory_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosSale" ADD CONSTRAINT "PosSale_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosSaleLine" ADD CONSTRAINT "PosSaleLine_posSaleId_fkey" FOREIGN KEY ("posSaleId") REFERENCES "PosSale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosSaleLine" ADD CONSTRAINT "PosSaleLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthlyContext" ADD CONSTRAINT "MonthlyContext_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Promo" ADD CONSTRAINT "Promo_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prediction" ADD CONSTRAINT "Prediction_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prediction" ADD CONSTRAINT "Prediction_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security (hand-appended; prisma migrate does not manage policies).
-- Fail-closed: current_setting('app.tenant_id', true) is NULL when the GUC is
-- unset, so a query outside prismaForTenant matches no rows.
ALTER TABLE "SalesHistory" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "SalesHistory"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "PosSale" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PosSale"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "PosSaleLine" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PosSaleLine"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "MonthlyContext" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "MonthlyContext"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "Promo" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Promo"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "Prediction" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Prediction"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "BacktestRun" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "BacktestRun"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "SpotCheck" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "SpotCheck"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
