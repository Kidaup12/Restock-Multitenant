import crypto from "node:crypto";
import { prismaService } from "@wezesha/db";

/**
 * POS feed credentials. The feed has no session, so the caller names the tenant
 * it is posting for — which makes the secret the only thing between one shop's
 * till and another shop's sales history. So the secret is per tenant
 * (TenantConfig.posIngestSecretHash) and is checked against the tenant the slug
 * resolved to: a bridge holding shop A's secret can never write into shop B.
 *
 * Fail-closed and deliberately uninformative:
 *   - no secret provisioned = ingest is closed for that tenant. There is no
 *     process-wide fallback credential to inherit.
 *   - unknown slug, blank secret and wrong secret are the same answer (null),
 *     reached through the same lookups and the same compare, so a caller can't
 *     enumerate tenants by status or by timing.
 */

/** Storage form of an ingest secret: SHA-256 hex. A fast digest is right here —
 *  the secret is a machine-generated 256-bit token (see generatePosIngestSecret),
 *  not a guessable password, so there is nothing for a slow KDF to protect. */
export function hashPosIngestSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret, "utf8").digest("hex");
}

/** A fresh ingest secret to hand a POS bridge (256 bits, URL-safe). */
export function generatePosIngestSecret(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** Per-process stand-in so an unprovisioned tenant costs the same compare as a
 *  provisioned one — and can never match, whatever the caller sends. */
const DECOY_HASH = crypto.randomBytes(32).toString("hex");

/** Constant-time digest compare. Unequal lengths are a mismatch, never a throw:
 *  a hand-edited hash column must reject the call, not 500 the endpoint. */
function digestMatches(presented: string, stored: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(stored);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

type FeedTenant = { id: string; secretHash: string | null };

/** Resolve the tenant a feed slug belongs to: an explicit posFeedSlug wins, else
 *  the tenant's own slug. Both lookups always run, so a miss does the same work
 *  as a hit. Runs on the service client (a feed has no session) — read-only, and
 *  nothing downstream sees a tenant until the secret has been verified. */
async function resolveFeedTenant(slug: string): Promise<FeedTenant | null> {
  const [byFeedSlug, byTenantSlug] = await Promise.all([
    prismaService.tenantConfig.findFirst({
      where: { posFeedSlug: slug },
      select: { tenantId: true, posIngestSecretHash: true },
    }),
    prismaService.tenant.findUnique({
      where: { slug },
      select: { id: true, tenantConfig: { select: { posIngestSecretHash: true } } },
    }),
  ]);
  if (byFeedSlug) return { id: byFeedSlug.tenantId, secretHash: byFeedSlug.posIngestSecretHash };
  if (byTenantSlug) {
    return { id: byTenantSlug.id, secretHash: byTenantSlug.tenantConfig?.posIngestSecretHash ?? null };
  }
  return null;
}

/**
 * Authenticate a POS feed call: resolve the slug, then verify the presented
 * bearer secret against THAT tenant's stored hash. Null = rejected, with no hint
 * as to why (unknown slug / not provisioned / wrong secret). Callers must answer
 * all three identically.
 */
export async function authenticatePosFeed(
  slug: string,
  presentedSecret: string
): Promise<{ id: string } | null> {
  const tenant = await resolveFeedTenant(slug.trim());
  const secret = presentedSecret.trim();
  const stored = tenant?.secretHash?.trim() || DECOY_HASH;
  // Always hash and always compare, so the rejected paths cost what the
  // accepted one does.
  const matches = digestMatches(hashPosIngestSecret(secret), stored);
  if (!tenant || secret.length === 0 || !matches) return null;
  return { id: tenant.id };
}
