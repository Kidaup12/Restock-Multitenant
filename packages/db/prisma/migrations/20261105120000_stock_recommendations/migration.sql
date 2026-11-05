-- AlterTable
ALTER TABLE "Notification" ADD COLUMN "href" TEXT;

-- CreateTable
CREATE TABLE "StockRecommendation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "payload" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "aiReason" TEXT,
    "aiIdea" TEXT,
    "cashKes" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "idleUnits" INTEGER NOT NULL DEFAULT 0,
    "snoozedUntil" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "StockRecommendation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StockRecommendation_tenantId_productId_action_key" ON "StockRecommendation"("tenantId", "productId", "action");

-- CreateIndex
CREATE INDEX "StockRecommendation_tenantId_status_idx" ON "StockRecommendation"("tenantId", "status");

-- AddForeignKey
ALTER TABLE "StockRecommendation" ADD CONSTRAINT "StockRecommendation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockRecommendation" ADD CONSTRAINT "StockRecommendation_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security (hand-appended; prisma migrate does not manage policies).
-- Fail-closed like every tenant table: outside prismaForTenant no rows match.
ALTER TABLE "StockRecommendation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockRecommendation" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "StockRecommendation"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
