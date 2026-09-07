"use server";

import { revalidatePath } from "next/cache";
import { captureError } from "@wezesha/observability";
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
 *
 * Nothing here may throw. The gate this answers covers the viewport and has no
 * dismiss, so an unhandled rejection does not degrade a screen — it shuts
 * someone out of the product with no message and no trace of why. Every failure
 * returns a result the caller can render, and is reported on the way past.
 */

export type AcceptTermsResult = { ok: true; at: string } | { ok: false; error: string };

const SAVE_FAILED = "That didn't save — try again.";

function report(what: string, err: unknown, tenantId: string | null): void {
  // Console as well as Sentry: captureError is a no-op wherever no DSN is
  // configured, and this is the one path where losing the reason leaves nothing
  // to diagnose from but an empty column.
  console.error(`terms acceptance: ${what}`, err);
  captureError(err, { tenantId, route: "acceptTermsAction" });
}

export async function acceptTermsAction(): Promise<AcceptTermsResult> {
  // Outside the try deliberately: requireSession signals its redirect by
  // throwing, so catching that here would strand an expired session on the gate
  // instead of sending it to /login.
  const session = await requireSession();

  try {
    const membership = await activeMembership(session.user.id);
    if (!membership) return { ok: false, error: "You're not in a workspace." };

    const accepted = await recordTermsAcceptance(membership.tenantId, membership.id);
    if (!accepted.at) return { ok: false, error: SAVE_FAILED };

    // Consent is exactly the kind of claim that has to be defensible later, so
    // it goes in the append-only ledger as well as on the membership row: the
    // column holds the current answer, the ledger holds every answer given.
    //
    // Reported, but not fatal. The stamp has already committed and it is what
    // the gate reads; returning someone to a modal they have just cleared
    // because the ledger insert failed is the worse of the two outcomes.
    try {
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
    } catch (err) {
      report("ledger write failed after the stamp committed", err, membership.tenantId);
    }

    // The gate is rendered by the shell layout above every route, so revalidating
    // "/settings" cleared it on one page and left every other cached segment
    // still carrying it.
    revalidatePath("/", "layout");
    return { ok: true, at: accepted.at.toISOString() };
  } catch (err) {
    report("could not record acceptance", err, null);
    return { ok: false, error: SAVE_FAILED };
  }
}
