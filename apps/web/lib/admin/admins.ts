import { PLATFORM_TENANT_ID, prismaService } from "@wezesha/db";
import type { AdminActor } from "@/lib/admin/gate";

/**
 * Who may open the console, granted and revoked from inside it.
 *
 * `PlatformAdmin` has always carried `grantedByUserId`, `grantedByEmail`,
 * `revokedAt` and `revokedByUserId`, and until now **nothing wrote a non-null
 * value to any of them** — the CLI bootstrap was the only way in, and it writes
 * nulls. So the columns that were supposed to answer "who let this person in"
 * answered "nobody knows", and the gate's own header claimed later grants came
 * through an audited console that did not exist.
 *
 * Reads run on the service client because the table is platform-level, not
 * tenant-owned. Every mutation here is called behind `requireAdmin` + step-up.
 */

export type PlatformAdminRow = {
  userId: string;
  email: string;
  name: string | null;
  grantedAt: Date;
  grantedByEmail: string | null;
  /** Null while the grant is live. */
  revokedAt: Date | null;
  revokedByEmail: string | null;
  /** True for a row the bootstrap script wrote — nobody granted it. */
  seeded: boolean;
  /** The caller's own row: the UI must not offer them a revoke button. */
  isSelf: boolean;
};

export type AdminMutationResult = { ok: true; message: string } | { ok: false; error: string };

/** Live and revoked, newest grant first. Revoked rows stay: the point of the
 *  table is that access history survives the access. */
export async function listPlatformAdmins(actor: AdminActor): Promise<PlatformAdminRow[]> {
  const rows = await prismaService.platformAdmin.findMany({
    orderBy: [{ revokedAt: "asc" }, { grantedAt: "desc" }],
    select: {
      userId: true,
      email: true,
      grantedAt: true,
      grantedByUserId: true,
      grantedByEmail: true,
      revokedAt: true,
      revokedByUserId: true,
    },
  });

  const userIds = [
    ...new Set(rows.flatMap((r) => [r.userId, r.revokedByUserId].filter((v): v is string => !!v))),
  ];
  const users = await prismaService.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, name: true, email: true },
  });
  const byId = new Map(users.map((u) => [u.id, u]));

  return rows.map((r) => ({
    userId: r.userId,
    email: r.email,
    name: byId.get(r.userId)?.name ?? null,
    grantedAt: r.grantedAt,
    grantedByEmail: r.grantedByEmail,
    revokedAt: r.revokedAt,
    revokedByEmail: r.revokedByUserId ? (byId.get(r.revokedByUserId)?.email ?? null) : null,
    seeded: r.grantedByUserId === null && r.grantedByEmail === null,
    isSelf: r.userId === actor.userId,
  }));
}

const norm = (email: string): string => email.trim().toLowerCase();

/**
 * Give an existing account console access.
 *
 * The account must already exist. Granting by email alone would let a typo
 * create a dormant grant that activates the day someone signs up with that
 * address — an admin seat nobody remembers issuing.
 */
export async function grantPlatformAdmin(
  actor: AdminActor,
  rawEmail: string
): Promise<AdminMutationResult> {
  const email = norm(rawEmail);
  if (!email) return { ok: false, error: "Enter an email address." };

  const user = await prismaService.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true, email: true },
  });
  if (!user) {
    return {
      ok: false,
      error: "No account with that address. They need to sign in once before you can grant access.",
    };
  }

  const existing = await prismaService.platformAdmin.findUnique({
    where: { userId: user.id },
    select: { revokedAt: true },
  });
  if (existing && existing.revokedAt === null) {
    return { ok: false, error: `${user.email} already has console access.` };
  }

  // Upsert rather than create: re-granting someone previously revoked reuses
  // their row (userId is unique), and clearing the revocation is what "granted
  // again" means.
  await prismaService.platformAdmin.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      email: norm(user.email),
      grantedByUserId: actor.userId,
      grantedByEmail: norm(actor.email),
    },
    update: {
      grantedAt: new Date(),
      grantedByUserId: actor.userId,
      grantedByEmail: norm(actor.email),
      revokedAt: null,
      revokedByUserId: null,
      // A re-grant starts the throttle clean; the old lockout belonged to the
      // access that was taken away.
      failedStepUps: 0,
      lockedUntil: null,
    },
  });

  await recordAdminChange(actor, "admin_granted", { subjectEmail: norm(user.email) });
  return { ok: true, message: `${user.email} can now open the console.` };
}

/**
 * Take console access away.
 *
 * Two refusals, both about not stranding the console: an admin cannot revoke
 * themselves (the mistake is one click and the recovery is a CLI run on a
 * production box), and the last live admin cannot be revoked at all — that would
 * leave the table empty, and an empty table hands the console back to whatever
 * addresses happen to sit in ADMIN_EMAILS.
 */
export async function revokePlatformAdmin(
  actor: AdminActor,
  userId: string
): Promise<AdminMutationResult> {
  if (userId === actor.userId) {
    return { ok: false, error: "You can't revoke your own access — ask another admin." };
  }

  const row = await prismaService.platformAdmin.findUnique({
    where: { userId },
    select: { email: true, revokedAt: true },
  });
  if (!row) return { ok: false, error: "That admin no longer exists." };
  if (row.revokedAt !== null) return { ok: false, error: `${row.email} is already revoked.` };

  const live = await prismaService.platformAdmin.count({ where: { revokedAt: null } });
  if (live <= 1) {
    return { ok: false, error: "That's the last admin — grant another before revoking this one." };
  }

  await prismaService.platformAdmin.update({
    where: { userId },
    data: { revokedAt: new Date(), revokedByUserId: actor.userId },
  });

  await recordAdminChange(actor, "admin_revoked", { subjectEmail: row.email });
  return { ok: true, message: `${row.email} no longer has console access.` };
}

/** Platform-level events key on the platform workspace — the row that exists so
 *  events about the operator, rather than about a customer, have somewhere
 *  honest to live. */
async function recordAdminChange(
  actor: AdminActor,
  action: "admin_granted" | "admin_revoked",
  meta: Record<string, unknown>
): Promise<void> {
  await prismaService.auditEvent.create({
    data: {
      tenantId: PLATFORM_TENANT_ID,
      entity: "PlatformAdmin",
      entityId: PLATFORM_TENANT_ID,
      action,
      actorUserId: actor.userId,
      actorName: actor.name,
      meta: { adminEmail: norm(actor.email), ...meta },
    },
  });
}
