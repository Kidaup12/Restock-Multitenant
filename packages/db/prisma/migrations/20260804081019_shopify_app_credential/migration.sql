-- CreateTable
CREATE TABLE "ShopifyAppCredential" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "apiSecret" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyAppCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyAppCredential_tenantId_key" ON "ShopifyAppCredential"("tenantId");

-- AddForeignKey
ALTER TABLE "ShopifyAppCredential" ADD CONSTRAINT "ShopifyAppCredential_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security (hand-appended; prisma migrate does not manage policies).
-- Fail-closed: current_setting('app.tenant_id', true) is NULL when the GUC is
-- unset, so a query outside prismaForTenant matches no rows. This table holds
-- one workspace's Shopify app secret; a missing policy would hand every client's
-- credentials to every other client.
ALTER TABLE "ShopifyAppCredential" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ShopifyAppCredential"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
