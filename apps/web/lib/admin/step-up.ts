import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { prismaService } from "@wezesha/db";
import { auth } from "@/lib/auth";
import type { AdminActor } from "@/lib/admin/gate";

/**
 * Step-up authentication for the operator console.
 *
 * A platform admin's session is otherwise indistinguishable from an ordinary
 * one, so an unlocked laptop is one URL away from every workspace's costs and
 * suppliers. Before entering a customer's workspace or changing anything, the
 * admin re-enters their password and gets a short-lived grant.
 *
 * Reads are deliberately not gated. Gate the fleet list and the audit log too
 * and people keep a grant warm all day, which defeats it.
 *
 * The cookie mirrors the workspace grant next door: `base64url(payload).hmac`
 * where payload is {"u": userId, "exp": epochMs}, HMAC-SHA256 keyed by
 * BETTER_AUTH_SECRET. It is bound to the user id and re-checked against the
 * live session on every use, so a grant left behind in a browser is worthless
 * to the next person to sign in on it.
 */

export const ADMIN_STEPUP_COOKIE = "wz-admin-stepup";

/** A grant lasts 30 minutes; stepping up again re-signs a fresh one. */
export const ADMIN_STEPUP_TTL_MS = 30 * 60 * 1000;

/** Wrong passwords before the account is locked out of stepping up. */
export const STEPUP_MAX_ATTEMPTS = 5;

/** How long a lockout lasts. */
export const STEPUP_LOCKOUT_MS = 15 * 60 * 1000;

function secret(): string {
  const value = process.env.BETTER_AUTH_SECRET;
  if (!value) throw new Error("BETTER_AUTH_SECRET is not set (admin step-up cookie signing)");
  return value;
}

function hmac(payload: string, key: string): Buffer {
  return createHmac("sha256", key).update(payload).digest();
}

/**
 * Signed cookie value granting step-up to one SESSION until now+TTL.
 *
 * The session, not the user. Keyed on the user alone, a grant outlived the
 * sign-out that should have ended it: nothing clears this cookie on the way
 * out (Better Auth owns sign-out and knows nothing about it), so the same
 * person signing back in inherited the rest of the 30 minutes and walked into
 * a customer's workspace without being asked for anything. Binding it here
 * closes that whether or not the cookie is ever cleared — a new session cannot
 * present a grant issued to an old one.
 */
export function signStepUp(
  userId: string,
  sessionId: string,
  now: number = Date.now(),
  key: string = secret()
): string {
  const payload = Buffer.from(
    JSON.stringify({ u: userId, s: sessionId, exp: now + ADMIN_STEPUP_TTL_MS })
  ).toString("base64url");
  return `${payload}.${hmac(payload, key).toString("base64url")}`;
}

/** The session a cookie value grants, or null on tamper/expiry/garbage. A
 *  grant signed before this change carries no session and is refused — the
 *  worst it costs anyone is typing their password once. */
export function verifyStepUp(
  value: string | null | undefined,
  now: number = Date.now(),
  key: string = secret()
): { userId: string; sessionId: string } | null {
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

  let parsed: { u?: unknown; s?: unknown; exp?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed.u !== "string" || typeof parsed.exp !== "number") return null;
  if (typeof parsed.s !== "string") return null;
  if (parsed.exp <= now) return null;
  return { userId: parsed.u, sessionId: parsed.s };
}

async function setStepUpCookie(userId: string, sessionId: string): Promise<void> {
  (await cookies()).set(ADMIN_STEPUP_COOKIE, signStepUp(userId, sessionId), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    // Scoped to the console, like the workspace grant: the shop's own screens
    // never step up, so the cookie has no business travelling with them.
    path: "/admin",
    maxAge: ADMIN_STEPUP_TTL_MS / 1000,
  });
}

export async function clearStepUpCookie(): Promise<void> {
  (await cookies()).set(ADMIN_STEPUP_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/admin",
    maxAge: 0,
  });
}

/**
 * Does this admin hold a live step-up grant?
 *
 * Takes the actor the gate already resolved rather than re-resolving it, so a
 * mutation costs one admin lookup, not two. A fallback admin never holds one:
 * the throttle below lives on the PlatformAdmin row, and an admin without a row
 * has nowhere to hold a failure count.
 */
export async function hasStepUp(actor: AdminActor): Promise<boolean> {
  if (actor.viaFallback) return false;
  const value = (await cookies()).get(ADMIN_STEPUP_COOKIE)?.value;
  const grant = verifyStepUp(value);
  // Both, not either: the session is what makes signing out actually end the
  // grant, and the user is checked anyway so a session id alone could never
  // stand in for one.
  return grant !== null && grant.userId === actor.userId && grant.sessionId === actor.sessionId;
}

export type StepUpResult =
  | { ok: true }
  | { ok: false; reason: "wrong_password" | "locked" | "no_password" | "not_eligible"; message: string };

type ThrottleRow = { failedStepUps: number; lockedUntil: Date | null };

/**
 * Raise the failure count and report the state, in one statement.
 *
 * Atomic and BEFORE the password is hashed, for two reasons: read-then-write
 * lets concurrent attempts all see the same count, and scrypt costs ~100ms, so
 * an already-locked caller who still reaches the hash is a way to burn CPU
 * rather than merely a way to guess.
 *
 * A lock that has expired opens a fresh window rather than resuming at the old
 * count, which would lock the account again on its first mistake.
 */
async function countAttempt(userId: string): Promise<ThrottleRow | null> {
  const [row] = await prismaService.$queryRaw<ThrottleRow[]>`
    UPDATE "PlatformAdmin"
       SET "failedStepUps" = CASE
             WHEN "lockedUntil" IS NOT NULL AND "lockedUntil" > now() THEN "failedStepUps"
             WHEN "lockedUntil" IS NOT NULL THEN 1
             ELSE "failedStepUps" + 1 END,
           "lockedUntil" = CASE
             WHEN "lockedUntil" IS NOT NULL AND "lockedUntil" > now() THEN "lockedUntil"
             ELSE NULL END
     WHERE "userId" = ${userId} AND "revokedAt" IS NULL
    RETURNING "failedStepUps", "lockedUntil"
  `;
  return row ?? null;
}

/**
 * Verify an admin's password and, on success, mint the grant.
 *
 * The hash is compared through Better Auth's own configured hasher rather than
 * importing scrypt directly, so a future change to the hashing config cannot
 * silently start rejecting every correct password.
 */
export async function grantStepUp(actor: AdminActor, password: string): Promise<StepUpResult> {
  if (actor.viaFallback) {
    return {
      ok: false,
      reason: "not_eligible",
      message: "Your access comes from the bootstrap list. Ask an admin to grant you access properly.",
    };
  }

  const throttle = await countAttempt(actor.userId);
  if (!throttle) {
    return { ok: false, reason: "not_eligible", message: "You are not a platform admin." };
  }
  if (throttle.lockedUntil && throttle.lockedUntil.getTime() > Date.now()) {
    return { ok: false, reason: "locked", message: lockedMessage(throttle.lockedUntil) };
  }
  if (throttle.failedStepUps > STEPUP_MAX_ATTEMPTS) {
    const until = new Date(Date.now() + STEPUP_LOCKOUT_MS);
    await prismaService.platformAdmin.update({
      where: { userId: actor.userId },
      data: { lockedUntil: until },
    });
    return { ok: false, reason: "locked", message: lockedMessage(until) };
  }

  const account = await prismaService.account.findFirst({
    where: { userId: actor.userId, providerId: "credential", password: { not: null } },
    select: { password: true },
  });
  if (!account?.password) {
    // Distinct from a wrong password on purpose: "it says my password is wrong
    // but I can sign in" is how an account with no password reports itself.
    return {
      ok: false,
      reason: "no_password",
      message: "This account signs in with an email code and has no password to confirm.",
    };
  }

  const ctx = await auth.$context;
  const correct = await ctx.password.verify({ hash: account.password, password });
  if (!correct) {
    return { ok: false, reason: "wrong_password", message: "That password is not right." };
  }

  await prismaService.platformAdmin.update({
    where: { userId: actor.userId },
    data: { failedStepUps: 0, lockedUntil: null },
  });
  await setStepUpCookie(actor.userId, actor.sessionId);
  return { ok: true };
}

function lockedMessage(until: Date): string {
  const minutes = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60_000));
  return `Too many wrong passwords. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}
