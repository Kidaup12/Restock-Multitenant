import { cache } from "react";
import { notFound } from "next/navigation";
import { prismaService } from "@wezesha/db";
import { auth, getSession, type AppSession } from "@/lib/auth";

/**
 * Cross-tenant admin console gate. Access is an operator allow-list, not a
 * tenant role: the PlatformAdmin table names the only accounts that may see
 * /admin, and a row records who granted it and when.
 *
 * ADMIN_EMAILS survives as a bootstrap only — it answers "who is an admin while
 * the table has no live row", so a fresh deploy is not locked out of its own
 * console. The moment one row exists the env var is inert, which is deliberate:
 * an admin list nobody can revoke without a redeploy is the thing this replaces.
 *
 * A fallback admin can read but not act. Every mutation needs a step-up grant,
 * and the step-up throttle lives on the PlatformAdmin row — an admin who has no
 * row has nowhere to hold a failure count, which would leave the one password
 * check in the system unthrottled in exactly the window it matters most.
 *
 * Non-admins get a 404, never a 403: the surface should not advertise its
 * existence to anyone probing paths with a normal account.
 */

export type AdminActor = {
  userId: string;
  /** The session this access came through. A step-up grant is bound to it, so
   *  signing out and back in cannot inherit one — the user is the same, the
   *  session is not. */
  sessionId: string;
  email: string;
  name: string;
  /** True when this access comes from ADMIN_EMAILS rather than a PlatformAdmin
   *  row. Reads only — see the file header. */
  viaFallback: boolean;
};

/** ADMIN_EMAILS parsed to a normalized (trimmed, lowercased) list. */
export function parseAdminEmails(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return parseAdminEmails(process.env.ADMIN_EMAILS).includes(email.trim().toLowerCase());
}

type AdminCensus = { live: number; mine: number };

/**
 * Both questions in one statement: how many admins hold access at all, and
 * whether this user is one of them.
 *
 * One query rather than "look me up, and if that misses, count the table",
 * because the miss is the hot path — this runs on every authenticated shell
 * render and almost nobody is an admin. The table holds single digits of rows,
 * so the scan is one page.
 */
const adminCensus = cache(async (userId: string): Promise<AdminCensus> => {
  const [row] = await prismaService.$queryRaw<{ live: bigint; mine: bigint }[]>`
    SELECT count(*) FILTER (WHERE "revokedAt" IS NULL) AS live,
           count(*) FILTER (WHERE "revokedAt" IS NULL AND "userId" = ${userId}) AS mine
      FROM "PlatformAdmin"
  `;
  return { live: Number(row?.live ?? 0), mine: Number(row?.mine ?? 0) };
});

/** Admin access for this session, or null. Fails closed: a database error is a
 *  404, never an open door. */
async function resolveActor(session: AppSession | null): Promise<AdminActor | null> {
  if (!session) return null;

  let census: AdminCensus;
  try {
    census = await adminCensus(session.user.id);
  } catch (err) {
    console.error("admin gate: could not read the platform admin list", err);
    return null;
  }

  if (census.mine > 0) return toActor(session, false);
  // The env var only answers while nobody holds a row. Once one does, an
  // address left in ADMIN_EMAILS grants nothing.
  if (census.live === 0 && isAdminEmail(session.user.email)) return toActor(session, true);
  return null;
}

function toActor(session: AppSession, viaFallback: boolean): AdminActor {
  return {
    userId: session.user.id,
    sessionId: session.session.id,
    email: session.user.email,
    name: session.user.name,
    viaFallback,
  };
}

/** Whether this user may see the console — for deciding whether to render a
 *  link to it. The gate below is the enforcement; this is only the hint. */
export async function isPlatformAdmin(session: AppSession | null): Promise<boolean> {
  return (await resolveActor(session)) !== null;
}

/** Page gate: the admin for this request, or a 404 render. */
export async function requireAdmin(): Promise<AdminActor> {
  const actor = await resolveActor(await getSession());
  if (!actor) notFound();
  return actor;
}

/** Route-handler gate: same check, resolved from the request's own headers so
 *  handlers stay callable outside Next's request scope (tests). Null = the
 *  caller responds 404 — not 401/403 — to keep the no-advertising posture. */
export async function adminFromHeaders(headers: Headers): Promise<AdminActor | null> {
  return resolveActor(await auth.api.getSession({ headers }));
}
