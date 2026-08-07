"use server";

import { clearAdminTenantCookie } from "@/lib/admin/impersonation";
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
 * Deliberately unguarded: it only ever deletes, and requiring an admin to prove
 * who they are in order to clear their own cookies would fail exactly when the
 * session has already gone.
 */
export async function clearAdminCookies(): Promise<void> {
  await clearStepUpCookie();
  await clearAdminTenantCookie();
}
