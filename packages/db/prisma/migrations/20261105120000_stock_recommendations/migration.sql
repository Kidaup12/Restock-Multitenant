-- Idempotent on purpose: this can be pasted into the Supabase SQL editor ahead
-- of `prisma migrate deploy`, and the later deploy re-runs it harmlessly.

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "href" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "StockRecommendation" (
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
CREATE UNIQUE INDEX IF NOT EXISTS "StockRecommendation_tenantId_productId_action_key" ON "StockRecommendation"("tenantId", "productId", "action");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StockRecommendation_tenantId_status_idx" ON "StockRecommendation"("tenantId", "status");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "StockRecommendation" ADD CONSTRAINT "StockRecommendation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "StockRecommendation" ADD CONSTRAINT "StockRecommendation_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Row-Level Security (hand-appended; prisma migrate does not manage policies).
-- Fail-closed like every tenant table: outside prismaForTenant no rows match.
ALTER TABLE "StockRecommendation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockRecommendation" FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY tenant_isolation ON "StockRecommendation"
    USING ("tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Table access for the app roles (also covered by the schema's default
-- privileges; repeated so a hand-run in the SQL editor ends up identical).
GRANT SELECT, INSERT, UPDATE, DELETE ON "StockRecommendation" TO wezesha_app, wezesha_service;
