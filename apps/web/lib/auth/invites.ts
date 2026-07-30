import { randomBytes } from "node:crypto";
import { prismaAuth, prismaForTenant, prismaService } from "@wezesha/db";
import { sendEmail } from "@/lib/email";
import { checkLimit } from "@/lib/limits/evaluate";

/**
 * Teammate invites without an invite table: each pending invite is a row in
 * Better Auth's Verification table —
 *   id         = the URL token (192-bit random; possession is the credential)
 *   identifier = `invite:{tenantId}:{email}` (email lowercased)
 *   value      = the role the invite grants ("ADMIN" | "MEMBER")
 *   expiresAt  = 7 days out
 * One live invite per (tenant, email): inviting again replaces the old row.
 * Accepting creates the Membership through the tenant-scoped client and
 * consumes the row; expired rows are swept when the team page lists invites.
 */

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const IDENTIFIER_PREFIX = "invite:";

/**
 * Roles an invite can carry.
 *
 * OWNER is here for the operator-led path only: an admin provisioning a
 * workspace for a customer who has not signed up yet has no other way to hand
 * them the shop. It is deliberately NOT offered inside a workspace —
 * `invitableRoles` never returns it, and the team action keeps its own narrower
 * check — because a tenant being able to mint owners is an escalation, not a
 * feature.
 */
export type InviteRole = "OWNER" | "ADMIN" | "MEMBER";

export type PendingInvite = {
  token: string;
  tenantId: string;
  email: string;
  role: InviteRole;
  expiresAt: Date;
};

export function normalizeInviteEmail(email: string): string {
  return email.trim().toLowerCase();
}

function identifierFor(tenantId: string, email: string): string {
  return `${IDENTIFIER_PREFIX}${tenantId}:${email}`;
}

function parseIdentifier(
  identifier: string,
): { tenantId: string; email: string } | null {
  if (!identifier.startsWith(IDENTIFIER_PREFIX)) return null;
  const rest = identifier.slice(IDENTIFIER_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0 || sep === rest.length - 1) return null;
  return { tenantId: rest.slice(0, sep), email: rest.slice(sep + 1) };
}

function isInviteRole(value: string): value is InviteRole {
  return value === "OWNER" || value === "ADMIN" || value === "MEMBER";
}

function toPendingInvite(row: {
  id: string;
  identifier: string;
  value: string;
  expiresAt: Date;
}): PendingInvite | null {
  const parsed = parseIdentifier(row.identifier);
  if (!parsed || !isInviteRole(row.value)) return null;
  return {
    token: row.id,
    tenantId: parsed.tenantId,
    email: parsed.email,
    role: row.value,
    expiresAt: row.expiresAt,
  };
}

export type CreateInviteResult =
  | { ok: true; invite: PendingInvite }
  | { ok: false; error: string };

/** Create (or replace) the pending invite for this tenant + email. */
export async function createInvite(input: {
  tenantId: string;
  email: string;
  role: InviteRole;
}): Promise<CreateInviteResult> {
  const email = normalizeInviteEmail(input.email);
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return { ok: false, error: "Enter a valid email address." };
  }

  // Already a member? (User emails are global; membership check is tenant-scoped.)
  // eslint-disable-next-line tenant-safety/require-tenant-scope -- User is a global table with no tenantId; the tenant-scoped membership check on the result is the actual guard.
  const user = await prismaService.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true },
  });
  if (user) {
    const existing = await prismaForTenant(input.tenantId).membership.findFirst({
      where: { userId: user.id },
      select: { id: true },
    });
    if (existing) {
      return { ok: false, error: "That person is already a member." };
    }
  }

  // The seat is checked again on acceptance (that's the write that counts), but
  // refusing here tells the person doing the inviting now, instead of letting a
  // teammate discover it on a dead link.
  const seat = await checkLimit(input.tenantId, "invite_member");
  if (!seat.allowed) {
    return {
      ok: false,
      error: seat.message ?? "This workspace is at its plan limit for team members.",
    };
  }

  const identifier = identifierFor(input.tenantId, email);
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  await prismaAuth.verification.deleteMany({ where: { identifier } });
  await prismaAuth.verification.create({
    data: { id: token, identifier, value: input.role, expiresAt },
  });
  return {
    ok: true,
    invite: { token, tenantId: input.tenantId, email, role: input.role, expiresAt },
  };
}

export type InviteLookup =
  | { status: "valid"; invite: PendingInvite; tenantName: string }
  | { status: "expired" }
  | { status: "invalid" };

/** Resolve an invite token for display/acceptance. */
export async function getInvite(token: string): Promise<InviteLookup> {
  if (!token) return { status: "invalid" };
  const row = await prismaAuth.verification.findUnique({ where: { id: token } });
  if (!row) return { status: "invalid" };
  const invite = toPendingInvite(row);
  if (!invite) return { status: "invalid" };
  if (invite.expiresAt.getTime() <= Date.now()) return { status: "expired" };
  // eslint-disable-next-line tenant-safety/require-tenant-scope -- name lookup for the invite card, keyed by the tenant id carried in the signed token; the invitee has no membership to resolve through yet.
  const tenant = await prismaService.tenant.findUnique({
    where: { id: invite.tenantId },
    select: { name: true },
  });
  if (!tenant) return { status: "invalid" };
  return { status: "valid", invite, tenantName: tenant.name };
}

export type AcceptInviteResult =
  | { ok: true; tenantId: string; alreadyMember: boolean }
  | { ok: false; code: "invalid" | "expired" | "email_mismatch" | "plan_limit" };

/**
 * Consume a token for a signed-in user: create the Membership (through the
 * tenant-scoped client, so RLS checks the write) and delete the row. A user
 * who is already a member still consumes the token and lands in the workspace.
 *
 * This is the write that moves the member count, so it is the enforcement
 * point: a refusal leaves the token intact, so the same link works once the
 * workspace frees a place.
 */
export async function acceptInvite(input: {
  token: string;
  userId: string;
  userEmail: string;
}): Promise<AcceptInviteResult> {
  const lookup = await getInvite(input.token);
  if (lookup.status !== "valid") return { ok: false, code: lookup.status };
  const { invite } = lookup;
  if (normalizeInviteEmail(input.userEmail) !== invite.email) {
    return { ok: false, code: "email_mismatch" };
  }

  const db = prismaForTenant(invite.tenantId);
  // Someone who is already a member takes no new place, so the plan check only
  // applies to a genuinely new membership.
  const member = await db.membership.findFirst({
    where: { userId: input.userId },
    select: { id: true },
  });
  if (!member && !(await checkLimit(invite.tenantId, "invite_member")).allowed) {
    return { ok: false, code: "plan_limit" };
  }

  let alreadyMember = false;
  try {
    await db.membership.create({
      data: {
        userId: input.userId,
        tenantId: invite.tenantId,
        role: invite.role,
      },
    });
  } catch (error) {
    // Unique (userId, tenantId) hit — accepted twice in a race, or invited
    // while already a member. The invite is still consumed below.
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code?: string }).code === "P2002"
    ) {
      alreadyMember = true;
    } else {
      throw error;
    }
  }
  await prismaAuth.verification.deleteMany({ where: { id: invite.token } });
  return { ok: true, tenantId: invite.tenantId, alreadyMember };
}

/** Pending invites for a tenant, soonest-expiring last; sweeps expired rows. */
export async function listInvites(tenantId: string): Promise<PendingInvite[]> {
  const prefix = identifierFor(tenantId, "");
  await prismaAuth.verification.deleteMany({
    where: { identifier: { startsWith: prefix }, expiresAt: { lte: new Date() } },
  });
  const rows = await prismaAuth.verification.findMany({
    where: { identifier: { startsWith: prefix } },
    orderBy: { createdAt: "asc" },
  });
  return rows
    .map(toPendingInvite)
    .filter((invite): invite is PendingInvite => invite !== null);
}

/** Cancel a pending invite; scoped to the tenant so a foreign token is a no-op. */
export async function cancelInvite(
  tenantId: string,
  token: string,
): Promise<boolean> {
  const { count } = await prismaAuth.verification.deleteMany({
    where: { id: token, identifier: { startsWith: identifierFor(tenantId, "") } },
  });
  return count > 0;
}

/** Email the invite link through the outbound seam (console in dev). */
export async function sendInviteEmail(input: {
  invite: PendingInvite;
  tenantName: string;
  invitedBy: string;
}): Promise<void> {
  const base = process.env.BETTER_AUTH_URL;
  if (!base) {
    throw new Error("BETTER_AUTH_URL is not set (needed for invite links)");
  }
  const url = `${base.replace(/\/$/, "")}/invite/${input.invite.token}`;
  const roleLabel =
    input.invite.role === "OWNER" ? "its owner" : input.invite.role === "ADMIN" ? "an admin" : "a member";
  await sendEmail({
    to: input.invite.email,
    subject: `You've been invited to ${input.tenantName} on Wezesha Restock`,
    text:
      `${input.invitedBy} invited you to join ${input.tenantName} as ${roleLabel}.\n\n` +
      `Accept the invite:\n\n${url}\n\n` +
      `The link expires in 7 days. If you weren't expecting this, ignore this email.`,
  });
}
