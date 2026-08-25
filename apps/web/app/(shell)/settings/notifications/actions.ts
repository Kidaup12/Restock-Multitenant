"use server";

import { revalidatePath } from "next/cache";
import { prismaForTenant } from "@wezesha/db";
import { parseNotifyPrefs, type NotifyPrefs } from "@wezesha/db/notify-prefs";
import { activeMembership, requireSession } from "@/lib/auth";

/**
 * A member's own email preferences, for the workspace they are currently in.
 *
 * Deliberately NOT permission-gated. Every other settings action asks for
 * `manage_settings`, because it changes something the whole shop lives with;
 * this changes only which messages land in the caller's own inbox, so a
 * money-blind staff member controls theirs without being able to touch anything
 * else. The row written is resolved from the session, never from input — there
 * is no membership id to tamper with.
 */

export type NotificationsActionResult = { ok: true } | { ok: false; error: string };

export async function saveNotificationPrefs(
  input: NotifyPrefs
): Promise<NotificationsActionResult> {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) return { ok: false, error: "You're not in a workspace." };

  // Only the keys this build knows survive the round trip, so a crafted payload
  // cannot park arbitrary JSON on the row.
  const notifyPrefs = parseNotifyPrefs(input);
  const db = prismaForTenant(membership.tenantId);
  const { count } = await db.membership.updateMany({
    where: { id: membership.id, userId: session.user.id },
    data: { notifyPrefs },
  });
  if (count === 0) return { ok: false, error: "That membership no longer exists." };

  revalidatePath("/settings/notifications");
  return { ok: true };
}
