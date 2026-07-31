-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "isSystem" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "PlatformAdmin" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "grantedByUserId" TEXT,
    "grantedByEmail" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "failedStepUps" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),

    CONSTRAINT "PlatformAdmin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlatformAdmin_userId_key" ON "PlatformAdmin"("userId");

-- CreateIndex
CREATE INDEX "PlatformAdmin_revokedAt_idx" ON "PlatformAdmin"("revokedAt");

-- Take PlatformAdmin away from the request-time role entirely.
--
-- This table decides who can read every workspace on the platform. The role
-- bootstrap grants SELECT/INSERT/UPDATE/DELETE on ALL tables and sets default
-- privileges on future ones, so without this block `wezesha_app` — the role
-- every user request runs as — would hold full read and write on it the moment
-- it was created. One mis-built query in tenant-scoped code would then be the
-- distance between a bug and an attacker granting themselves the fleet.
--
-- No application path needs it: the console reads and writes this table through
-- the service client (BYPASSRLS), the same way it already reads across tenants.
-- Same double lock as the credential tables, because the two failures are
-- independent: REVOKE removes the privilege, and RLS enabled with no policy
-- denies every row to any non-BYPASSRLS role even if a later migration re-grants.
REVOKE ALL PRIVILEGES ON TABLE "PlatformAdmin" FROM wezesha_app;
ALTER TABLE "PlatformAdmin" ENABLE ROW LEVEL SECURITY;

-- Wezesha's own workspace.
--
-- Platform-level admin actions (granting admin, revoking it, step-up) belong to
-- no customer, but AuditEvent.tenantId is a real reference with an RLS policy
-- keyed on it. Rather than make the column nullable or write a sentinel that
-- every other row treats as a real id, those events key on a workspace that
-- genuinely exists.
--
-- It is memberless, so it is unreachable through the app: every tenant read
-- resolves through a membership and there is none. Its slug uses underscores,
-- which workspaceSlug() strips — no customer-generated slug can ever collide
-- with it, so this insert cannot fail on a name someone else picked first.
INSERT INTO "Tenant" ("id", "name", "slug", "isSystem", "createdAt")
VALUES ('platform', 'Wezesha Platform', '__platform__', true, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "TenantConfig" ("id", "tenantId", "updatedAt")
VALUES ('platform-config', 'platform', CURRENT_TIMESTAMP)
ON CONFLICT ("tenantId") DO NOTHING;
