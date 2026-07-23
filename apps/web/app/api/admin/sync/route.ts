import { NextResponse } from "next/server";
import { prismaForTenant } from "@wezesha/db";
import { adminFromHeaders } from "@/lib/admin/gate";
import { recordAdminEvent } from "@/lib/admin/audit";
import { enqueueShopifySync } from "@/lib/shopify/queue";

/**
 * Admin re-run of a customer's sync. Same no-overlap contract as the tenant's
 * own sync-now: the response IS the guard's verdict (`enqueued: false` + the
 * blocking job's state when one is already queued or running). Every trigger
 * writes an audit row, including blocked ones — "an admin pressed the button"
 * is the fact being logged, not "a job started".
 *
 * Non-admins get 404, not 401/403: this surface does not advertise itself.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const admin = await adminFromHeaders(req.headers);
  if (!admin) return NextResponse.json({ error: "not found" }, { status: 404 });

  let tenantId: string;
  try {
    const body = (await req.json()) as { tenantId?: unknown };
    if (typeof body.tenantId !== "string" || body.tenantId.length === 0) {
      return NextResponse.json({ error: "tenantId is required" }, { status: 400 });
    }
    tenantId = body.tenantId;
  } catch {
    return NextResponse.json({ error: "tenantId is required" }, { status: 400 });
  }

  // Tenant-scoped read: a bogus tenantId simply finds no connection.
  const connection = await prismaForTenant(tenantId).shopifyConnection.findFirst();
  if (!connection || connection.uninstalledAt) {
    return NextResponse.json({ error: "No live Shopify connection to sync." }, { status: 400 });
  }

  try {
    const result = await enqueueShopifySync(tenantId);
    await recordAdminEvent({
      tenantId,
      action: "admin_sync_trigger",
      admin,
      meta: { enqueued: result.enqueued, ...(result.enqueued ? {} : { blockedBy: result.state }) },
    });
    return NextResponse.json(result);
  } catch (err) {
    console.error("admin sync enqueue failed", err);
    return NextResponse.json({ error: "Could not reach the job queue." }, { status: 503 });
  }
}
