-- CreateTable
CREATE TABLE "EmailLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "kind" TEXT,
    "status" TEXT NOT NULL,
    "providerId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailLog_tenantId_createdAt_idx" ON "EmailLog"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailLog_status_createdAt_idx" ON "EmailLog"("status", "createdAt");

-- Row-Level Security (hand-appended; prisma migrate does not manage policies).
-- Fail-closed twice over: current_setting('app.tenant_id', true) is NULL when
-- the GUC is unset, so a query outside prismaForTenant matches no rows; and
-- "tenantId" is nullable here, so a row belonging to no workspace (a password
-- reset sent before one is resolved) compares NULL = NULL — also never true,
-- and so reachable only by the BYPASSRLS service client that writes it.
--
-- FORCE as well as ENABLE: the earlier force_rls_on_tenant_tables migration ran
-- once over the tables that existed then, so every new tenant table has to
-- bring its own or the coverage census fails it.
ALTER TABLE "EmailLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmailLog" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "EmailLog"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
