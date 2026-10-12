"use server";

import { activeMembership, requireSession } from "@/lib/auth";
import { getInventoryPosition } from "@/lib/data/inventory-position";
import { positionWindow } from "@/lib/inventory/position";

export async function exportInventoryPosition(windowDays: number, search: string) {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) return [];
  const report = await getInventoryPosition(membership.tenantId, positionWindow(windowDays), search.slice(0, 200));
  return report.rows;
}
