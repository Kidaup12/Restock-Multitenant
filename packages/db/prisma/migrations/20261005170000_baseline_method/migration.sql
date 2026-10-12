ALTER TABLE "TenantConfig" ADD COLUMN "baselineMethod" TEXT;
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_baselineMethod_check"
  CHECK ("baselineMethod" IS NULL OR "baselineMethod" IN ('mean', 'median'));
