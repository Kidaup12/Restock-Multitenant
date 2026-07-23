import { notFound } from "next/navigation";
import { auth, getSession, type AppSession } from "@/lib/auth";

/**
 * Cross-tenant admin console gate. Access is an operator allow-list, not a
 * tenant role: ADMIN_EMAILS (comma-separated, case-insensitive) names the
 * only accounts that may see /admin. Unset or empty means nobody — the
 * console fails closed.
 *
 * Non-admins get a 404, never a 403: the surface should not advertise its
 * existence to anyone probing paths with a normal account.
 */

export type AdminActor = {
  userId: string;
  email: string;
  name: string;
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

function toActor(session: AppSession): AdminActor {
  return {
    userId: session.user.id,
    email: session.user.email,
    name: session.user.name,
  };
}

/** Page gate: the allow-listed admin for this request, or a 404 render. */
export async function requireAdmin(): Promise<AdminActor> {
  const session = await getSession();
  if (!session || !isAdminEmail(session.user.email)) notFound();
  return toActor(session);
}

/** Route-handler gate: same check, resolved from the request's own headers so
 *  handlers stay callable outside Next's request scope (tests). Null = the
 *  caller responds 404 — not 401/403 — to keep the no-advertising posture. */
export async function adminFromHeaders(headers: Headers): Promise<AdminActor | null> {
  const session = await auth.api.getSession({ headers });
  if (!session || !isAdminEmail(session.user.email)) return null;
  return toActor(session);
}
