-- Per-tenant POS ingest credential. SHA-256 (hex) of the tenant's bearer
-- secret; the plaintext is shown once at provisioning and never stored.
-- Nullable and null by default: every existing tenant starts with POS ingest
-- closed until an operator provisions a secret (fail-closed).
-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN "posIngestSecretHash" TEXT;
