"use server";

import { revalidatePath } from "next/cache";
import { activeMembership, requireSession } from "@/lib/auth";
import { dismissGapAsClosure, ignorePosSku, matchPosSku } from "@/lib/pos/match";
import { enqueuePosSync } from "@/lib/pos/queue";

/**
 * POS fix-queue actions. Admin-only (repair tools per spec §3): each action
 * re-resolves the caller's membership server-side and requires OWNER/ADMIN — a
 * money-blind MEMBER can see the queue but not rewrite sales attribution. The
 * tenant id always comes from the membership, never the client. Logic lives in
 * lib/pos/* so it stays testable without a request context.
 */

export type PosActionResult = { ok: true; message?: string } | { ok: false; error: string };

const err = (error: string): PosActionResult => ({ ok: false, error });

async function adminContext() {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) return null;
  if (membership.role !== "OWNER" && membership.role !== "ADMIN") return null;
  return {
    tenantId: membership.tenantId,
    actor: {
      userId: session.user.id,
      name: membership.displayName ?? session.user.name ?? session.user.email,
    },
  };
}

export async function matchPosSkuAction(input: { sku: string; productId: string }): Promise<PosActionResult> {
  const ctx = await adminContext();
  if (!ctx) return err("You need admin access to fix POS sales.");
  if (!input.productId) return err("Pick a product to match this till SKU to.");

  const result = await matchPosSku(ctx.tenantId, input, ctx.actor);
  if (!result.ok) {
    const messages = {
      no_product: "That product no longer exists.",
      no_lines: "Those till lines are already matched.",
      bad_sku: "Pick a till SKU to match.",
    } as const;
    return err(messages[result.reason]);
  }
  revalidatePath("/sales");
  return {
    ok: true,
    message: `Matched ${result.matchedLines} till line${result.matchedLines === 1 ? "" : "s"} — run rate updated.`,
  };
}

export async function ignorePosSkuAction(input: { sku: string }): Promise<PosActionResult> {
  const ctx = await adminContext();
  if (!ctx) return err("You need admin access to fix POS sales.");

  const result = await ignorePosSku(ctx.tenantId, input, ctx.actor);
  if (!result.ok) return err("Pick a till SKU to ignore.");
  revalidatePath("/sales");
  return { ok: true, message: "Ignored — this till SKU won't queue again." };
}

export async function dismissGapAction(input: { locationId: string; dayKey: string }): Promise<PosActionResult> {
  const ctx = await adminContext();
  if (!ctx) return err("You need admin access to resolve sales gaps.");

  const result = await dismissGapAsClosure(ctx.tenantId, input, ctx.actor);
  if (!result.ok) {
    const messages = {
      no_location: "That branch no longer exists.",
      bad_day: "That day looks invalid.",
    } as const;
    return err(messages[result.reason]);
  }
  revalidatePath("/sales");
  return { ok: true, message: "Marked closed — the forecast treats it as a no-trading day." };
}

export async function repullGapAction(): Promise<PosActionResult> {
  const ctx = await adminContext();
  if (!ctx) return err("You need admin access to re-pull sales.");
  try {
    await enqueuePosSync(ctx.tenantId);
  } catch {
    return err("Couldn't start a re-pull — the sync service is unavailable.");
  }
  return { ok: true, message: "Re-pulling POS sales now — the gap clears once the feed lands." };
}
