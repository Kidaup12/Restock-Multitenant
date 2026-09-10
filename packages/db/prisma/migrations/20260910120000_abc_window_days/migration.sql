-- How far back the ABC ranking counts what a product earned. Nullable and
-- null for every existing shop, which reads as the 90-day default: a window is
-- a preference, and no shop has expressed one yet.
-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN "abcWindowDays" INTEGER;
