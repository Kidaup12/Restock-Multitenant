import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { emailOTP } from "better-auth/plugins";
import { prismaAuth, prismaService } from "@wezesha/db";
import { sendEmail } from "@/lib/email";

/**
 * Better Auth server instance. Email+password plus an email-OTP alternative;
 * sessions are httpOnly cookies backed by the Session table. Auth tables are
 * global (no tenantId), hence the service-scope prismaAuth client.
 */
export const auth = betterAuth({
  database: prismaAdapter(prismaAuth, { provider: "postgresql" }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    sendResetPassword: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        subject: "Reset your Wezesha Restock password",
        text: `Follow this link to choose a new password:\n\n${url}\n\nIf you didn't request this, ignore this email — your password is unchanged.`,
        // No tenant: the reset is addressed to an account, which may belong to
        // several workspaces or none. Naming one here would be a guess.
        kind: "password_reset",
      });
    },
  },
  plugins: [
    emailOTP({
      // Sign-IN only. Without this the endpoint mails a code to any address on
      // request and verifying it creates the account — an unauthenticated
      // account-creation and unmetered outbound-email path. A workspace is
      // reached by invite or by /signup, never by asking for a code.
      disableSignUp: true,
      async sendVerificationOTP({ email, otp }) {
        await sendEmail({
          to: email,
          subject: "Your Wezesha Restock sign-in code",
          text: `Your sign-in code is ${otp}. It expires in 5 minutes.`,
          // No tenant: the code is mailed before any session, so no workspace
          // has been resolved yet.
          kind: "sign_in_code",
        });
      },
    }),
    // Keep last: lets auth responses set cookies through Next's cookie API.
    nextCookies(),
  ],
});

export type AppSession = typeof auth.$Infer.Session;

/** Session for the current request, or null. */
export async function getSession(): Promise<AppSession | null> {
  return auth.api.getSession({ headers: await headers() });
}

/** Session or a redirect to /login — the server-side gate behind the
 *  (optimistic, cookie-presence-only) middleware check. */
export async function requireSession(): Promise<AppSession> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

/** Cookie that pins the active workspace (a tenant id). Set only by
 *  setWorkspaceCookie; always validated against real memberships on read. */
export const WORKSPACE_COOKIE = "wz-workspace";

/**
 * The user's active workspace: the `wz-workspace` cookie when it names a
 * workspace the user actually belongs to, otherwise the earliest membership.
 * Every tenant-scoped page resolves its tenant through this one path. Runs on
 * the service client — membership resolution is the auth bootstrap step that
 * happens before any tenant scope exists.
 */
export async function activeMembership(userId: string) {
  const preferred = (await cookies()).get(WORKSPACE_COOKIE)?.value ?? null;
  return resolveActiveMembership(userId, preferred);
}

/** Cookie-free core of activeMembership; what the tests exercise. */
export async function resolveActiveMembership(
  userId: string,
  preferredTenantId: string | null,
) {
  if (preferredTenantId) {
    // Membership resolution is the bootstrap that establishes tenant scope, so
    // it runs on the service client; the compound key names the tenant.
    const preferred = await prismaService.membership.findUnique({
      where: { userId_tenantId: { userId, tenantId: preferredTenantId } },
      include: { tenant: true },
    });
    if (preferred) return preferred;
  }
  // eslint-disable-next-line tenant-safety/require-tenant-scope -- fallback arm of the same bootstrap: pick the user's earliest workspace when no preference is set.
  return prismaService.membership.findFirst({
    where: { userId },
    orderBy: { createdAt: "asc" },
    include: { tenant: true },
  });
}

/** All the user's memberships for the workspace switcher, earliest first. */
export async function listMemberships(userId: string) {
  // eslint-disable-next-line tenant-safety/require-tenant-scope -- the workspace switcher lists the user's own memberships; it spans tenants because the user does.
  return prismaService.membership.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    include: { tenant: true },
  });
}

/** Point the workspace cookie at a tenant. Callers must have verified the
 *  user's membership first — the cookie is a preference, not a credential
 *  (activeMembership re-validates on every read). */
export async function setWorkspaceCookie(tenantId: string): Promise<void> {
  (await cookies()).set(WORKSPACE_COOKIE, tenantId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

/** Only same-app relative paths are allowed as post-auth redirect targets. */
export function safeInternalPath(path: string | null | undefined): string | null {
  if (!path || !path.startsWith("/") || path.startsWith("//")) return null;
  return path;
}
