import { NextResponse } from "next/server";
import { prismaForTenant } from "@wezesha/db";
import { tenantActor } from "@/lib/shopify/membership";
import { enqueueShopifySync } from "@/lib/shopify/queue";

/**
 * Sync-now. The response IS the no-overlap guard's verdict: `enqueued: false`
 * with the blocking job's state when a sync is already queued or running, so
 * the UI can say so instead of silently double-clicking into nothing.
 */
export async function POST(): Promise<NextResponse> {
  const actor = await tenantActor();
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const connection = await prismaForTenant(actor.tenantId).shopifyConnection.findFirst();
  if (!connection || connection.uninstalledAt) {
    return NextResponse.json({ error: "No live Shopify connection to sync." }, { status: 400 });
  }

  try {
    const result = await enqueueShopifySync(actor.tenantId);
    return NextResponse.json(result);
  } catch (err) {
    console.error("shopify sync enqueue failed", err);
    return NextResponse.json({ error: "Could not reach the job queue." }, { status: 503 });
  }
}
