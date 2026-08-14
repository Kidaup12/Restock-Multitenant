"use server";

import { requireAdmin } from "@/lib/admin/gate";
import { endAdminWorkspace } from "@/lib/admin/impersonation";
import { clearStepUpCookie } from "@/lib/admin/step-up";

/**
 * Drop the console's own cookies on the way out.
 *
 * Sign-out belongs to Better Auth, which clears its session cookie and knows
 * nothing about ours — so a step-up grant and an open workspace visit both used
 * to survive it. The grant is bound to the session now, which is what actually
 * closes the hole; this is the hygiene that should have been there anyway, so a
 * shared machine is not left holding a signed cookie naming a customer.
 *
 * Signing out is also a way OUT of a customer's workspace, and until now the
 * commonest one — it cleared the grant without a word, which is why the ledger
 * held workspace visits that never closed. Ending the visit here is what makes
 * "when did the operator leave" answerable.
 *
 * Deliberately unguarded: it only ever deletes, and requiring an admin to prove
 * who they are in order to clear their own cookies would fail exactly when the
 * session has already gone. `requireAdmin` is called for the actor's identity
 * only — a refusal costs the audit row, never the clear.
 */
export async function clearAdminCookies(): Promise<void> {
  const admin = await requireAdmin().catch(() => null);
  await clearStepUpCookie();
  await endAdminWorkspace(admin, "sign_out");
}
