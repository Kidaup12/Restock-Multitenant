"use server";

import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { getSupplyCalendar, type SupplyCalendar } from "@/lib/data/plan-calendar";

/**
 * Loads the forward supply calendar on demand — the calendar view fetches it
 * when the user picks that mode, keeping the initial Plan payload lean. Tenant
 * and cost visibility resolve from the session server-side; the returned figures
 * are already redacted for a money-blind caller.
 */

export type LoadCalendarResult =
  | { ok: true; data: SupplyCalendar }
  | { ok: false; error: string };

export async function loadSupplyCalendar(): Promise<LoadCalendarResult> {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) return { ok: false, error: "You're not in a workspace." };

  const calendar = await getSupplyCalendar(membership.tenantId, {
    canViewCosts: hasPermission(membership, "view_costs"),
  });
  return { ok: true, data: calendar };
}
