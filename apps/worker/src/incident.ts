import type { Redis } from "ioredis";
import { prismaService } from "@wezesha/db";
import { sendEmail, type SendEmail } from "./email";

/**
 * Once-per-incident reconnect alerting.
 *
 * State lives in a Redis latch keyed per tenant+source, not in Notification
 * rows: SET NX is a single atomic operation, so two final failures racing
 * (e.g. a retry exhausting while an unrecoverable duplicate lands) cannot both
 * win and double-send — deriving the same answer from Notification rows would
 * need a read-then-write plus a "since last success" marker, which is exactly
 * this key. The bell keeps getting a Notification row per final failure (that
 * feed is the audit trail); the email fires only on the healthy→failed edge.
 * A successful sync deletes the latch, re-arming the alert for the next
 * incident. No TTL: a still-broken store stays one incident, one email.
 */

const incidentKey = (tenantId: string, source: string) =>
  `incident:sync:${tenantId}:${source}`;

/** Arm the latch. True only on the healthy→failed transition. */
export async function openIncident(
  redis: Redis,
  tenantId: string,
  source: string
): Promise<boolean> {
  return (await redis.set(incidentKey(tenantId, source), new Date().toISOString(), "NX")) === "OK";
}

/** Recovery: clear the latch so the next failure alerts again. */
export async function clearIncident(
  redis: Redis,
  tenantId: string,
  source: string
): Promise<void> {
  await redis.del(incidentKey(tenantId, source));
}

/**
 * Where a tenant's operational alerts go: TenantConfig.alertEmail when set,
 * else the earliest OWNER's login email. Runs on prismaService with an
 * explicit tenantId filter — alert routing is a system path (no session, no
 * request), the documented use of the BYPASSRLS client.
 */
export async function alertRecipient(
  tenantId: string
): Promise<{ email: string; tenantName: string } | null> {
  const tenant = await prismaService.tenant.findUnique({
    where: { id: tenantId },
    select: { name: true, tenantConfig: { select: { alertEmail: true } } },
  });
  if (!tenant) return null;
  if (tenant.tenantConfig?.alertEmail) {
    return { email: tenant.tenantConfig.alertEmail, tenantName: tenant.name };
  }
  const owner = await prismaService.membership.findFirst({
    where: { tenantId, role: "OWNER" },
    orderBy: { createdAt: "asc" },
    select: { user: { select: { email: true } } },
  });
  return owner ? { email: owner.user.email, tenantName: tenant.name } : null;
}

/**
 * Send the reconnect/sync-failure alert for a final failure, at most once per
 * incident. Returns true when an email actually went out. No recipient (no
 * config, no owner — e.g. bare test fixtures) releases the latch so a later
 * failure retries the send instead of silently burning the one email.
 */
export async function sendIncidentAlert(options: {
  redis: Redis;
  tenantId: string;
  source: string;
  reason: string;
  send?: SendEmail;
}): Promise<boolean> {
  const { redis, tenantId, source, reason, send = sendEmail } = options;
  if (!(await openIncident(redis, tenantId, source))) return false;

  const recipient = await alertRecipient(tenantId);
  if (!recipient) {
    await clearIncident(redis, tenantId, source);
    return false;
  }
  try {
    await send({
      to: recipient.email,
      subject: `Action needed: ${recipient.tenantName} stock sync is failing`,
      text:
        `The ${source} sync for ${recipient.tenantName} stopped working and has run out of retries.\n\n` +
        `Reason: ${reason}\n\n` +
        `Open Settings → Connections in Wezesha Restock to reconnect the store. ` +
        `You'll get one email per incident — syncs resuming resets the alert.`,
    });
    return true;
  } catch (err) {
    // Failed send: re-arm so the next failure can try again.
    await clearIncident(redis, tenantId, source);
    throw err;
  }
}
