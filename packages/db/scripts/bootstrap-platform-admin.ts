import "dotenv/config";
import { pathToFileURL } from "node:url";
import { prismaService } from "../src/client";
import { PLATFORM_TENANT_ID } from "../src/platform-tenant";

/**
 * Seed the first platform admin.
 *
 * The console gate reads the PlatformAdmin table and falls back to ADMIN_EMAILS
 * only while that table has no live row. This is the other way in — and the one
 * that works when the env var is unset, set to somebody else, or simply not
 * worth a redeploy. Once one row exists the env var is inert.
 *
 * Grants made here record no granter: nobody had the standing to grant them.
 * That null is the honest record of a bootstrap, and it is what distinguishes
 * these rows from every later one, which came through the audited console.
 *
 * Idempotent. Running it for someone who already holds admin reports that and
 * changes nothing; running it for someone whose access was revoked restores it
 * and says so, so an accidental re-run cannot quietly resurrect an admin.
 *
 * Run from packages/db (dotenv reads ./.env):
 *   npx tsx scripts/bootstrap-platform-admin.ts <email>
 * Against production, supply the URLs the migration uses:
 *   SERVICE_DATABASE_URL=<...> npx tsx scripts/bootstrap-platform-admin.ts <email>
 */

export type BootstrapOutcome =
  | { ok: true; status: "granted" | "restored" | "already"; userId: string; email: string }
  | { ok: false; error: string };

export async function bootstrapPlatformAdmin(rawEmail: string): Promise<BootstrapOutcome> {
  const email = rawEmail.trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return { ok: false, error: `"${rawEmail}" is not an email address.` };
  }

  const user = await prismaService.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true, email: true, name: true },
  });
  if (!user) {
    return {
      ok: false,
      error: `No account for ${email}. They have to sign up before they can be made an admin.`,
    };
  }

  // Step-up authentication asks a platform admin to re-enter their password
  // before every privileged action. Someone who has only ever signed in with an
  // email code has no password to re-enter, so granting them admin would hand
  // them a console where every mutation refuses them — and the refusal reads as
  // "wrong password", which is the worst possible way to find out.
  const credential = await prismaService.account.findFirst({
    where: { userId: user.id, providerId: "credential", password: { not: null } },
    select: { id: true },
  });
  if (!credential) {
    return {
      ok: false,
      error:
        `${email} signs in with an email code and has no password. Platform admins ` +
        `step up with a password before every privileged action, so set one first.`,
    };
  }

  const platform = await prismaService.tenant.findUnique({
    where: { id: PLATFORM_TENANT_ID },
    select: { id: true },
  });
  if (!platform) {
    return {
      ok: false,
      error:
        "The platform workspace is missing — run the migrations first " +
        "(it anchors the audit row this grant writes).",
    };
  }

  const existing = await prismaService.platformAdmin.findUnique({
    where: { userId: user.id },
    select: { id: true, revokedAt: true },
  });
  if (existing && existing.revokedAt === null) {
    return { ok: true, status: "already", userId: user.id, email: user.email };
  }

  const status = existing ? "restored" : "granted";
  await prismaService.platformAdmin.upsert({
    where: { userId: user.id },
    create: { userId: user.id, email },
    // A restored admin starts clean: the old revocation, granter and any
    // step-up lockout are all history, not state to carry forward.
    update: {
      email,
      revokedAt: null,
      revokedByUserId: null,
      grantedByUserId: null,
      grantedByEmail: null,
      grantedAt: new Date(),
      failedStepUps: 0,
      lockedUntil: null,
    },
  });

  await prismaService.auditEvent.create({
    data: {
      tenantId: PLATFORM_TENANT_ID,
      entity: "PlatformAdmin",
      entityId: user.id,
      action: "platform_admin_granted",
      actorUserId: null,
      actorName: null,
      meta: { email, via: "bootstrap", restored: status === "restored" },
    },
  });

  return { ok: true, status, userId: user.id, email: user.email };
}

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const email = process.argv[2];
  if (!email) {
    console.error("usage: npx tsx scripts/bootstrap-platform-admin.ts <email>");
    process.exitCode = 1;
  } else {
    bootstrapPlatformAdmin(email)
      .then(async (result) => {
        if (!result.ok) {
          console.error(result.error);
          process.exitCode = 1;
        } else if (result.status === "already") {
          console.log(`${result.email} is already a platform admin — nothing changed.`);
        } else if (result.status === "restored") {
          console.log(`Restored platform admin for ${result.email} (access had been revoked).`);
        } else {
          console.log(`${result.email} is now a platform admin.`);
        }
        // Printed on the failure path too, and phrased as state rather than
        // outcome: after a refusal, "am I still locked out of the console" is
        // the thing the person running this actually needs to know.
        const live = await prismaService.platformAdmin.count({ where: { revokedAt: null } });
        console.log(`Platform admins with access: ${live}.`);
        return prismaService.$disconnect();
      })
      .catch((err) => {
        console.error("bootstrap-platform-admin failed:", err);
        process.exitCode = 1;
        return prismaService.$disconnect();
      });
  }
}
