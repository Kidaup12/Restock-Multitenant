-- CreateTable
CREATE TABLE "QuickBooksConnection" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "realmId" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "accessTokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "refreshTokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "scopes" TEXT NOT NULL,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnectedAt" TIMESTAMP(3),
    "authFailureCount" INTEGER NOT NULL DEFAULT 0,
    "syncPausedAt" TIMESTAMP(3),
    "lastAuthErrorAt" TIMESTAMP(3),
    "lastAuthError" TEXT,

    CONSTRAINT "QuickBooksConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QuickBooksConnection_tenantId_key" ON "QuickBooksConnection"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "QuickBooksConnection_realmId_key" ON "QuickBooksConnection"("realmId");

-- AddForeignKey
ALTER TABLE "QuickBooksConnection" ADD CONSTRAINT "QuickBooksConnection_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security (hand-appended; prisma migrate does not manage policies).
-- Fail-closed: current_setting('app.tenant_id', true) is NULL when the GUC is
-- unset, so a query outside prismaForTenant matches no rows. This table holds
-- OAuth tokens for a workspace's accounting books — a missing policy would hand
-- every client's QuickBooks access to every other client.
--
-- FORCE as well as ENABLE: the earlier force_rls_on_tenant_tables migration ran
-- once over the tables that existed then, so every new tenant table has to bring
-- its own or the coverage census fails it.
ALTER TABLE "QuickBooksConnection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "QuickBooksConnection" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "QuickBooksConnection"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
