import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

/**
 * Issue (or rotate) one tenant's POS ingest secret — the credential its POS
 * bridge sends as `Authorization: Bearer <secret>` to POST /api/pos/ingest. The
 * secret is valid for that tenant only; until one is issued, the endpoint is
 * closed for the tenant.
 *
 * Only the SHA-256 is stored, so the secret is printed once and can never be
 * read back — a lost secret is rotated, not recovered. Re-running kills the
 * previous secret, so coordinate with whoever runs the bridge.
 *
 * Run from packages/pos:
 *   npx tsx scripts/provision-ingest-secret.ts <tenant-slug>
 */

// Reuse the db package's local .env, same as this workspace's tests do, and
// load it before the client module reads SERVICE_DATABASE_URL.
const dbEnv = fileURLToPath(new URL("../../db/.env", import.meta.url));
if (existsSync(dbEnv)) config({ path: dbEnv });

const { prismaService } = await import("@wezesha/db");
const { generatePosIngestSecret, hashPosIngestSecret } = await import("../src/auth");

async function main(): Promise<void> {
  const slug = process.argv[2]?.trim();
  if (!slug) {
    console.error("usage: npx tsx scripts/provision-ingest-secret.ts <tenant-slug>");
    process.exitCode = 1;
    return;
  }

  const tenant = await prismaService.tenant.findUnique({
    where: { slug },
    select: { id: true, name: true, tenantConfig: { select: { posFeedSlug: true } } },
  });
  if (!tenant) {
    console.error(`no tenant with slug "${slug}"`);
    process.exitCode = 1;
    return;
  }

  const secret = generatePosIngestSecret();
  const posIngestSecretHash = hashPosIngestSecret(secret);
  await prismaService.tenantConfig.upsert({
    where: { tenantId: tenant.id },
    create: { tenantId: tenant.id, posIngestSecretHash },
    update: { posIngestSecretHash },
  });

  console.log(
    `POS ingest secret issued for ${tenant.name}\n` +
    `  feed slug: ${tenant.tenantConfig?.posFeedSlug ?? slug}\n` +
    `  secret:    ${secret}\n` +
    "Shown once — put it in the bridge's credential store now. Any previous secret is dead."
  );
}

await main()
  .catch((err) => {
    console.error("provision-ingest-secret failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prismaService.$disconnect());
