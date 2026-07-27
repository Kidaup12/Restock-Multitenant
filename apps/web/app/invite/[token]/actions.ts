"use server";

import { redirect } from "next/navigation";
import { getSession, setWorkspaceCookie } from "@/lib/auth";
import { acceptInvite } from "@/lib/auth/invites";

const messages = {
  invalid: "This invite link is no longer valid. Ask for a new invite.",
  expired: "This invite has expired. Ask for a new invite.",
  email_mismatch:
    "This invite was sent to a different email address. Sign in with the invited account.",
  // Worded for the person joining, who can't fix it themselves — the owner can.
  plan_limit:
    "This workspace already has all the team members its plan includes. Ask an admin there to free up a place or move to a bigger plan, then use this link again.",
} as const;

/** Join the workspace behind the token, land in it, and start there. */
export async function acceptInviteAction(
  token: string,
): Promise<{ error: string }> {
  const session = await getSession();
  if (!session) redirect(`/login?redirect=/invite/${encodeURIComponent(token)}`);
  const result = await acceptInvite({
    token,
    userId: session.user.id,
    userEmail: session.user.email,
  });
  if (!result.ok) return { error: messages[result.code] };
  await setWorkspaceCookie(result.tenantId);
  redirect("/today");
}
