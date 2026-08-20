"use server";

import { revalidatePath } from "next/cache";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { cancelPo } from "@/lib/po/cancel-po";
import { createPoFromOrders } from "@/lib/po/create-po";
import { receivePoLines, type ReceiveEntry } from "@/lib/po/receive-po";
import { sendPoToSupplier } from "@/lib/po/send-po";

/**
 * Purchase-order actions. Every action re-resolves the caller's active
 * membership and re-checks the permission server-side; the tenant id always
 * comes from the membership, never from the client. The heavy lifting lives
 * in lib/po/* so it stays testable without a request context.
 */

export type PoActionResult = { ok: true; message?: string } | { ok: false; error: string };

const err = (error: string): PoActionResult => ({ ok: false, error });

async function actorContext() {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) return null;
  if (!hasPermission(membership, "approve_orders")) return null;
  return {
    tenantId: membership.tenantId,
    actor: {
      userId: session.user.id,
      name: membership.displayName ?? session.user.name ?? session.user.email,
    },
  };
}

export async function createPoAction(input: { orderIds: string[] }): Promise<PoActionResult> {
  const ctx = await actorContext();
  if (!ctx) return err("You don't have ordering access in this workspace.");
  if (input.orderIds.length === 0) return err("Select at least one product.");

  const result = await createPoFromOrders(ctx.tenantId, input.orderIds, ctx.actor);
  if (!result.ok) {
    const messages = {
      no_orders: "Those queue items are no longer pending.",
      mixed_suppliers: "A purchase order can only cover one supplier.",
      no_supplier: "These products have no supplier assigned yet.",
    } as const;
    return err(messages[result.reason]);
  }
  revalidatePath("/orders");
  return { ok: true, message: `Created ${result.poNumber}.` };
}

export async function sendPoAction(input: { poId: string }): Promise<PoActionResult> {
  const ctx = await actorContext();
  if (!ctx) return err("You don't have ordering access in this workspace.");

  const result = await sendPoToSupplier(ctx.tenantId, input.poId, ctx.actor);
  if (!result.ok) {
    const messages = {
      not_found: "That purchase order no longer exists.",
      not_sendable: "Only a draft purchase order can be sent.",
      no_supplier_email: "Add an email address for this supplier first.",
    } as const;
    return err(messages[result.reason]);
  }
  revalidatePath("/orders");
  revalidatePath(`/orders/${input.poId}`);
  // Say which of the two things happened. The order is marked sent either way —
  // that part is real — but reporting an email that never left tells a shop the
  // supplier knows about an order they have never seen.
  return {
    ok: true,
    message: result.emailed
      ? "Purchase order emailed to the supplier."
      : "Purchase order marked as sent, but the email did not go out — the supplier has not been told.",
  };
}

export async function receivePoAction(input: {
  poId: string;
  locationId: string;
  entries: ReceiveEntry[];
}): Promise<PoActionResult> {
  const ctx = await actorContext();
  if (!ctx) return err("You don't have ordering access in this workspace.");

  const result = await receivePoLines(
    ctx.tenantId,
    input.poId,
    input.entries,
    input.locationId,
    ctx.actor
  );
  if (!result.ok) {
    const messages = {
      not_found: "That purchase order no longer exists.",
      not_receivable: "This purchase order isn't open for receiving.",
      bad_location: "Pick a valid location to receive into.",
      bad_line: "One of those lines doesn't belong to this purchase order.",
      bad_qty: "A received quantity exceeds what's still outstanding.",
      empty: "Enter at least one received quantity.",
    } as const;
    return err(messages[result.reason]);
  }
  revalidatePath("/orders");
  revalidatePath(`/orders/${input.poId}`);
  const booked =
    result.status === "received"
      ? `Received ${result.receivedUnits} units — delivery complete.`
      : `Received ${result.receivedUnits} units — remainder still expected.`;
  return {
    ok: true,
    // Say plainly that the shelf figure is the store's. Silently leaving stock
    // unchanged after booking in a delivery reads as the receipt not working.
    message: result.stockFollowsStore
      ? `${booked} Stock stays as your store reports it — add the delivery there and it shows here after the next sync.`
      : booked,
  };
}

export async function cancelPoAction(input: { poId: string }): Promise<PoActionResult> {
  const ctx = await actorContext();
  if (!ctx) return err("You don't have ordering access in this workspace.");

  const result = await cancelPo(ctx.tenantId, input.poId, ctx.actor);
  if (!result.ok) {
    const messages = {
      not_found: "That purchase order no longer exists.",
      not_cancellable: "Only a draft or sent purchase order can be cancelled.",
    } as const;
    return err(messages[result.reason]);
  }
  revalidatePath("/orders");
  revalidatePath(`/orders/${input.poId}`);
  return { ok: true, message: "Purchase order cancelled — items returned to the queue." };
}
