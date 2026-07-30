import { prismaService } from "@wezesha/db";
import { createWorkspace } from "@/lib/auth/workspaces";
import {
  createInvite,
  normalizeInviteEmail,
  sendInviteEmail,
  type PendingInvite,
} from "@/lib/auth/invites";

/**
 * Stand a customer's workspace up from the admin console.
 *
 * Until now the only way a workspace came into being was somebody signing up and
 * making their own. That is fine for self-serve, and useless for the case the
 * business actually has: a shop that has agreed to use the product and needs
 * someone to set it up for them — which today means an engineer with database
 * access.
 *
 * Two shapes, decided by whether the owner already has an account:
 *  - they do → the workspace is created with them as OWNER, ready to use.
 *  - they don't → the workspace is created with NO members, and an OWNER invite
 *    is emailed. They sign up, accept, and the membership appears. A memberless
 *    workspace is unreachable in the meantime: every read resolves through a
 *    membership and there is none, so it is invisible rather than exposed.
 *
 * The email is looked up on the service client because User is a global table
 * with no tenant — the same seam invites already use.
 */

export type ProvisionResult =
  | {
      ok: true;
      tenantId: string;
      slug: string;
      /** How the owner gets in: already a member, or holding an invite. */
      owner: { status: "member"; email: string } | { status: "invited"; invite: PendingInvite };
    }
  | { ok: false; error: string };

export async function provisionWorkspace(input: {
  name: string;
  ownerEmail: string;
}): Promise<ProvisionResult> {
  const email = normalizeInviteEmail(input.ownerEmail);
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return { ok: false, error: "Enter a valid email address for the owner." };
  }

  // User is a global table with no tenantId, and this runs before the tenant it
  // will own exists — there is nothing to scope by yet.
  const existing = await prismaService.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true },
  });

  const created = await createWorkspace({ userId: existing?.id ?? null, name: input.name });
  if (!created.ok) return created;

  if (existing) {
    return {
      ok: true,
      tenantId: created.tenantId,
      slug: created.slug,
      owner: { status: "member", email },
    };
  }

  const invite = await createInvite({ tenantId: created.tenantId, email, role: "OWNER" });
  if (!invite.ok) {
    // The workspace exists but nobody can reach it. Say so plainly rather than
    // reporting success — the operator has to re-invite, and a silent failure
    // here is a workspace nobody ever claims.
    return {
      ok: false,
      error: `Workspace created, but the owner invite failed: ${invite.error}. Invite them again from this workspace.`,
    };
  }

  await sendInviteEmail({
    invite: invite.invite,
    tenantName: input.name.trim().replace(/\s+/g, " "),
    invitedBy: "The Wezesha Restock team",
  });

  return {
    ok: true,
    tenantId: created.tenantId,
    slug: created.slug,
    owner: { status: "invited", invite: invite.invite },
  };
}
