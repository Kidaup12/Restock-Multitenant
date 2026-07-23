"use server";

import { prismaForTenant, prismaService } from "@wezesha/db";
import {
  activeMembership,
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
  const membership = await prismaService.membership.findUnique({
    where: { userId_tenantId: { userId: session.user.id, tenantId } },
    select: { id: true },
  });
  if (!membership) return { ok: false };
  await setWorkspaceCookie(tenantId);
  return { ok: true };
}

/** Stamp the active membership as welcomed (tour finished or skipped). */
export async function markWelcomed(): Promise<void> {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) return;
  await prismaForTenant(membership.tenantId).membership.updateMany({
    where: { id: membership.id, userId: session.user.id },
    data: { welcomedAt: new Date() },
  });
}
