"use server";

import { prismaForTenant, prismaService } from "@wezesha/db";
import {
  listMemberships,
  requireSession,
  setWorkspaceCookie,
} from "@/lib/auth";

/**
 * Shell-level auth actions: workspace switching and the welcome-tour stamp.
 * Both re-verify the session and membership server-side — client state is
 * never trusted.
 */

/** Point the workspace cookie at another of the caller's workspaces. The
 *  membership check makes a forged tenant id a no-op. */
export async function switchWorkspace(
  tenantId: string,
): Promise<{ ok: boolean }> {
  const session = await requireSession();
  // This IS the membership check that authorises the tenant, so it runs on the
  // service client; the compound key still pins it to the tenant being claimed.
  const membership = await prismaService.membership.findUnique({
    where: { userId_tenantId: { userId: session.user.id, tenantId } },
    select: { id: true },
  });
  if (!membership) return { ok: false };
  await setWorkspaceCookie(tenantId);
  return { ok: true };
}

/**
 * Stamp the caller as welcomed (tour finished or skipped).
 *
 * Stamps EVERY membership the user holds, not just the active one. The tour
 * teaches the app, not the workspace, so someone who has already seen it should
 * not get it again for joining a second shop or switching between them — which
 * is what a per-membership stamp did. The profile menu still replays it on
 * demand.
 *
 * Written one workspace at a time through the tenant-scoped client rather than
 * as a single cross-tenant updateMany: the rows span tenants, but each write
 * stays inside the one it belongs to, so RLS remains the thing enforcing the
 * boundary. A user belongs to a handful of workspaces, not a page of them.
 */
export async function markWelcomed(): Promise<void> {
  const session = await requireSession();
  const memberships = await listMemberships(session.user.id);
  const now = new Date();
  await Promise.all(
    memberships
      .filter((m) => m.welcomedAt === null)
      .map((m) =>
        prismaForTenant(m.tenantId).membership.updateMany({
          where: { id: m.id, userId: session.user.id },
          data: { welcomedAt: now },
        })
      )
  );
}
