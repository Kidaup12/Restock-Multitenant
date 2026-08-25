import type { Redis } from "ioredis";
import { prismaService } from "@wezesha/db";
import { wantsEmail, type OptionalEmailKind } from "@wezesha/db/notify-prefs";
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
 * Who hears about a tenant's optional email, and the one place the preference
 * is enforced — both optional emails resolve through here, so a third added
 * later is opted in by construction and cannot forget to ask.
 *
 * Two routings, and the split is deliberate:
 *  - **An alert email is set.** That address wins outright, exactly as before.
 *    It is usually a shared ops inbox, it belongs to no user, and a shop that
 *    set it has chosen where its mail goes; fanning out to members as well
 *    would start writing to people who had routed these away.
 *  - **No alert email.** Everyone in the workspace who has not switched this
 *    kind off. Until now only the earliest OWNER heard anything, so a second
 *    owner or a manager was silently left out — this widens a default nobody
 *    picked rather than overriding a choice anyone made.
 *
 * Runs on prismaService with an explicit tenantId filter — alert routing is a
 * system path (no session, no request), the documented use of the BYPASSRLS
 * client.
 */
export async function alertRecipients(
  tenantId: string,
  kind: OptionalEmailKind
): Promise<{ emails: string[]; tenantName: string } | null> {
  // eslint-disable-next-line tenant-safety/require-tenant-scope -- reads one tenant by the id the job already carries; the worker has no session, so there is no resolver to route through.
  const tenant = await prismaService.tenant.findUnique({
    where: { id: tenantId },
    select: { name: true, tenantConfig: { select: { alertEmail: true } } },
  });
  if (!tenant) return null;
  if (tenant.tenantConfig?.alertEmail) {
    return { emails: [tenant.tenantConfig.alertEmail], tenantName: tenant.name };
  }
  const members = await prismaService.membership.findMany({
    where: { tenantId },
    orderBy: { createdAt: "asc" },
    select: { notifyPrefs: true, user: { select: { email: true } } },
  });
  const emails = [
    ...new Set(
      members.filter((m) => wantsEmail(m.notifyPrefs, kind)).map((m) => m.user.email)
    ),
  ];
  return emails.length > 0 ? { emails, tenantName: tenant.name } : null;
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

  const recipients = await alertRecipients(tenantId, "reconnect_alert");
  if (!recipients) {
    await clearIncident(redis, tenantId, source);
    return false;
  }
  try {
    // The latch guards the INCIDENT, not the address: one incident still means
    // one email, now one each. Sent in series so a failure to the second person
    // surfaces rather than being swallowed by a settled promise beside it.
    for (const to of recipients.emails) {
      await send({
        to,
        subject: `Action needed: ${recipients.tenantName} stock sync is failing`,
        text:
          `The ${source} sync for ${recipients.tenantName} stopped working and has run out of retries.\n\n` +
          `Reason: ${reason}\n\n` +
          `Open Settings → Connections in Wezesha Restock to reconnect the store. ` +
          `You'll get one email per incident — syncs resuming resets the alert.`,
        tenantId,
        kind: "reconnect_alert",
      });
    }
    return true;
  } catch (err) {
    // Failed send: re-arm so the next failure can try again.
    await clearIncident(redis, tenantId, source);
    throw err;
  }
}
