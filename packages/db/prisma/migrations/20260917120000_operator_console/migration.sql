-- Operator console: per-tenant feature grants/denies layered over the plan
-- tier, plus a billing period the console sets and the enforcement cron reads.
-- All additive and nullable — every existing row reads as "pure tier, no
-- billing record kept", which is what null has always meant here.
-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "featureOverrides" JSONB,
ADD COLUMN     "planPeriodEnd" TIMESTAMP(3),
ADD COLUMN     "planStatus" TEXT,
ADD COLUMN     "billingNote" TEXT;
