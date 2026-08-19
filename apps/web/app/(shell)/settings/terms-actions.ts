"use server";

import { revalidatePath } from "next/cache";
import { prismaService } from "@wezesha/db";
import { activeMembership, requireSession } from "@/lib/auth";
import { recordTermsAcceptance } from "@/lib/auth/terms";
import { TERMS_VERSION } from "@/lib/legal";

/**
 * Accepting the merchant terms.
 *
 * Every member accepts for themselves — this is not an owner-only action, and
 * carries no permission gate: consent cannot be given on someone else's behalf,
 * which is the whole point of recording it per membership.
 */

export type AcceptTermsResult = { ok: true; at: string } | { ok: false; error: string };

export async function acceptTermsAction(): Promise<AcceptTermsResult> {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) return { ok: false, error: "You're not in a workspace." };

  const accepted = await recordTermsAcceptance(membership.tenantId, membership.id);
  if (!accepted.at) return { ok: false, error: "That didn't save — try again." };

  // Consent is exactly the kind of claim that has to be defensible later, so it
  // goes in the append-only ledger as well as on the membership row: the column
  // holds the current answer, the ledger holds every answer given.
  await prismaService.auditEvent.create({
    data: {
      tenantId: membership.tenantId,
      entity: "Membership",
      entityId: membership.id,
      action: "terms_accepted",
      actorUserId: session.user.id,
      actorName: membership.displayName ?? session.user.name ?? session.user.email,
      meta: { version: TERMS_VERSION },
    },
  });

  revalidatePath("/settings");
  return { ok: true, at: accepted.at.toISOString() };
}
