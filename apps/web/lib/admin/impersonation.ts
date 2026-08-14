import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import type { AppSession } from "@/lib/auth";
import { isPlatformAdmin, type AdminActor } from "@/lib/admin/gate";
import { recordAdminEvent } from "@/lib/admin/audit";

/**
 * Admin workspace entry ("impersonation") — membership-free, time-boxed, and
 * honored only inside the admin surface. Entering a tenant sets a signed
 * short-lived cookie naming that tenant; /admin/tenant/[id] pages resolve it
 * through resolveAdminWorkspace and refuse to show tenant data without it.
 *
 * The cookie value is `base64url(payload).hmac` where payload is
 * {"t": tenantId, "exp": epochMs} and the HMAC-SHA256 is keyed by
 * BETTER_AUTH_SECRET — the same secret that already guards sessions, so a
 * forged workspace grant requires the same break as a forged session.
 * Verification is timing-safe and fails closed on any malformed, expired, or
 * tampered value. The cookie is a grant, not an identity: every read
 * additionally re-checks that the session still holds platform admin, so
 * revoking someone ends their workspace access on their next request rather
 * than when the cookie happens to expire.
 */

export const ADMIN_TENANT_COOKIE = "wz-admin-tenant";

/**
 * Entry expires after 30 minutes; re-entering re-signs a fresh grant.
 *
 * The cookie's maxAge is this same window, so a lapsed grant is already gone
 * from the browser: there is no later admin request holding it in which to
 * notice the expiry and write a closing row. What the ledger records instead is
 * the bound — every impersonation_start carries `meta.expiresAt`, which is the
 * exact instant a visit with no end row stopped working. That is a fact we know;
 * a row written whenever we next happened to look would be a timestamp we don't.
 */
export const ADMIN_TENANT_TTL_MS = 30 * 60 * 1000;

function secret(): string {
  const value = process.env.BETTER_AUTH_SECRET;
  if (!value) throw new Error("BETTER_AUTH_SECRET is not set (admin workspace cookie signing)");
  return value;
}

function hmac(payload: string, key: string): Buffer {
  return createHmac("sha256", key).update(payload).digest();
}

/** Signed cookie value granting admin access to one tenant until now+TTL. */
export function signAdminTenant(
  tenantId: string,
  now: number = Date.now(),
  key: string = secret()
): string {
  const payload = Buffer.from(
    JSON.stringify({ t: tenantId, exp: now + ADMIN_TENANT_TTL_MS })
  ).toString("base64url");
  return `${payload}.${hmac(payload, key).toString("base64url")}`;
}

/** The tenantId a cookie value grants, or null on tamper/expiry/garbage. */
export function verifyAdminTenant(
  value: string | null | undefined,
  now: number = Date.now(),
  key: string = secret()
): string | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);

  const expected = hmac(payload, key);
  let given: Buffer;
  try {
    given = Buffer.from(value.slice(dot + 1), "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let parsed: { t?: unknown; exp?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed.t !== "string" || typeof parsed.exp !== "number") return null;
  if (parsed.exp <= now) return null;
  return parsed.t;
}

export async function setAdminTenantCookie(tenantId: string): Promise<void> {
  (await cookies()).set(ADMIN_TENANT_COOKIE, signAdminTenant(tenantId), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/admin",
    maxAge: ADMIN_TENANT_TTL_MS / 1000,
  });
}

export async function clearAdminTenantCookie(): Promise<void> {
  (await cookies()).set(ADMIN_TENANT_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/admin",
    maxAge: 0,
  });
}

/**
 * How an open visit ended, as it lands in the ledger's `meta.reason`.
 *
 * All three are things a person did inside a request we were serving, so the
 * row's own timestamp is the real departure time. Expiry is not on this list
 * and has no reason code — see the note on the TTL above.
 */
export type WorkspaceExitReason =
  /** The admin clicked Leave. */
  | "exit"
  /** The admin signed out while still inside a workspace. */
  | "sign_out"
  /** A second entry re-signed the cookie, ending the visit it replaced. */
  | "superseded";

/**
 * Close an open workspace visit and drop the grant.
 *
 * Every path that takes a grant away goes through here, so a departure is
 * recorded when it happens rather than only when an admin remembers to click
 * Leave. Before this, sign-out and re-entry both cleared the cookie in silence,
 * and the ledger carried starts that never closed.
 *
 * Only a grant that still verifies produces a row: an already-lapsed cookie has
 * no visit left to close, and `admin` is null when the caller could not confirm
 * who is leaving — an unattributable end row is worse than none on a ledger
 * whose whole job is naming the actor. The clear runs either way, so a failed
 * ledger write is loud but never leaves a signed cookie naming a customer.
 *
 * Returns the tenant whose visit was closed, or null if none was open.
 */
export async function endAdminWorkspace(
  admin: AdminActor | null,
  reason: WorkspaceExitReason
): Promise<string | null> {
  const tenantId = verifyAdminTenant((await cookies()).get(ADMIN_TENANT_COOKIE)?.value);
  try {
    if (tenantId && admin) {
      await recordAdminEvent({ tenantId, action: "impersonation_end", admin, meta: { reason } });
    }
  } finally {
    await clearAdminTenantCookie();
  }
  return tenantId;
}

/**
 * The tenant the current admin request may act inside: session must be an
 * allow-listed admin AND the request must carry a live signed grant. Null
 * means "show the enter-workspace prompt", never an error.
 */
export async function resolveAdminWorkspace(
  session: AppSession | null
): Promise<{ tenantId: string } | null> {
  if (!(await isPlatformAdmin(session))) return null;
  const value = (await cookies()).get(ADMIN_TENANT_COOKIE)?.value;
  const tenantId = verifyAdminTenant(value);
  return tenantId ? { tenantId } : null;
}
