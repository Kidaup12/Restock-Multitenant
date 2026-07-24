-- Cost slice on Product: the prior-cost signal + cost-moved alert state
-- (spec §2 "Where cost comes from" / §4 "Cost moved sharply"). All nullable and
-- disjoint from the metric columns. Product already carries its tenant_isolation
-- RLS policy, so these columns inherit it — the coverage census stays green with
-- no policy change.
ALTER TABLE "Product"
    ADD COLUMN "costUpdatedAt" TIMESTAMP(3),
    ADD COLUMN "lastSyncedCostKes" DOUBLE PRECISION,
    ADD COLUMN "costMovedPct" DOUBLE PRECISION,
    ADD COLUMN "costMovedAt" TIMESTAMP(3);
