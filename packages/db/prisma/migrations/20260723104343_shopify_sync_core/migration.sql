-- AlterTable
ALTER TABLE "Supplier" ALTER COLUMN "leadTimeAvgDays" DROP NOT NULL,
ALTER COLUMN "leadTimeAvgDays" DROP DEFAULT;

-- CreateTable
CREATE TABLE "ShopifyConnection" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "scopes" TEXT NOT NULL,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),

    CONSTRAINT "ShopifyConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngestCursor" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "cursor" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IngestCursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyConnection_tenantId_key" ON "ShopifyConnection"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyConnection_shopDomain_key" ON "ShopifyConnection"("shopDomain");

-- CreateIndex
CREATE INDEX "IngestCursor_tenantId_idx" ON "IngestCursor"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "IngestCursor_tenantId_source_resource_key" ON "IngestCursor"("tenantId", "source", "resource");

-- CreateIndex
CREATE INDEX "Notification_tenantId_readAt_idx" ON "Notification"("tenantId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_webhookId_key" ON "WebhookEvent"("webhookId");

-- AddForeignKey
ALTER TABLE "ShopifyConnection" ADD CONSTRAINT "ShopifyConnection_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngestCursor" ADD CONSTRAINT "IngestCursor_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security (hand-appended; prisma migrate does not manage policies).
-- Fail-closed: current_setting('app.tenant_id', true) is NULL when the GUC is
-- unset, so a query outside prismaForTenant matches no rows.
-- WebhookEvent is deliberately absent: it is a GLOBAL dedupe ledger (no
-- tenantId), allow-listed in the rls-coverage census.
ALTER TABLE "ShopifyConnection" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ShopifyConnection"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "IngestCursor" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "IngestCursor"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "Notification" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Notification"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
