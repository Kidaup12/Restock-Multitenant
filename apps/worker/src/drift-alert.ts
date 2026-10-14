import { prismaService } from "@wezesha/db";
import { sendEmail, type SendEmail } from "./email";
import { describeDrift, type ReportDrift } from "./drift-report";

export type { DriftReport, ReportDrift } from "./drift-report";

/**
 * Tell the people who run the platform when a shop's data had drifted from its
 * store.
 *
 * Drift is found by the daily reconcile (sales rebuilt from Shopify and compared
 * with what the hourly runs wrote) and the nightly full catalogue pull (costs
 * that pull had to change). Either one correcting something means the
 * incremental sync missed it — a dropped webhook, a gap in a query, a bug — and
 * that is the operator's problem to look into, not the shop's: it goes to the
 * platform admins, never to the workspace. Until now the first anyone heard of
 * a gap was a client saying their numbers looked wrong.
 */

/** Best-effort by design: a failed alert is logged, never allowed to fail the
 *  sync whose data has, by this point, already been corrected. */
export function createDriftEmailer(send: SendEmail = sendEmail): ReportDrift {
  return async (tenantId, report) => {
    try {
      // eslint-disable-next-line tenant-safety/require-tenant-scope -- platform admins are not tenant data; this is an operator alert about one tenant, sent by the system.
      const admins = await prismaService.platformAdmin.findMany({
        where: { revokedAt: null },
        select: { email: true },
      });
      // eslint-disable-next-line tenant-safety/require-tenant-scope -- reads one tenant by the id the job already carries; the worker has no session.
      const tenant = await prismaService.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
      const { subject, text } = describeDrift(tenant?.name ?? tenantId, report);
      console.warn(`worker: sync drift for ${tenantId} — ${text.replace(/\s+/g, " ")}`);
      for (const { email } of admins) {
        await send({ to: email, subject, text, kind: "sync_drift" });
      }
    } catch (err) {
      console.error(`worker: sync drift alert failed for ${tenantId}`, err);
    }
  };
}

export const emailDriftToPlatformAdmins: ReportDrift = createDriftEmailer();
