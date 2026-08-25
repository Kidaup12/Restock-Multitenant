-- Per-member email preferences. Nullable and unbackfilled on purpose: absent
-- means "send it", so every existing member keeps receiving exactly what they
-- receive today and nobody is silenced by the deploy.
ALTER TABLE "Membership" ADD COLUMN "notifyPrefs" JSONB;
