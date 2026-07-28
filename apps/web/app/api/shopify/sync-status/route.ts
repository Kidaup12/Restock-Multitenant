import { NextResponse } from "next/server";
import { prismaForTenant } from "@wezesha/db";
import { tenantActor } from "@/lib/shopify/membership";
import { toSyncRunView } from "@/lib/shopify/sync-run";

/**
 * The current (or most recent) sync run. The Connections screen polls this when
 * the realtime socket isn't open — without a gateway configured, "live progress"
 * would otherwise be the same silence the feature exists to remove.
 *
 * Ungated beyond membership, matching sync-now: progress is not cost data, and
 * a member watching a sync is the normal case.
 */
export async function GET(): Promise<NextResponse> {
  const actor = await tenantActor();
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const run = await prismaForTenant(actor.tenantId).syncRun.findFirst({
    where: { source: "shopify" },
    orderBy: { startedAt: "desc" },
  });
  return NextResponse.json({ run: toSyncRunView(run, new Date()) });
}
