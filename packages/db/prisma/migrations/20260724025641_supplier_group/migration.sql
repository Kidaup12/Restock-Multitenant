-- Optional owner label ("Overseas", "Local pickup") shown as the Group column
-- and usable as a planner scope. Supplier already has RLS + the tenant_isolation
-- policy (see 20260723071358_catalog_inventory), so the new column is covered by
-- that row policy automatically — no policy change, coverage census stays green.

-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN     "supplierGroup" TEXT;
