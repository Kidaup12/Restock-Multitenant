-- AlterTable
ALTER TABLE "Prediction" ADD COLUMN     "explainParts" JSONB;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "plan" TEXT,
ADD COLUMN     "planLimits" JSONB;

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN     "limitsExceededAt" TIMESTAMP(3);
