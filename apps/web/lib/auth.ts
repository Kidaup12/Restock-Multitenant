import { headers } from "next/headers";
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
      });
    },
  },
  plugins: [
    emailOTP({
      async sendVerificationOTP({ email, otp }) {
        await sendEmail({
          to: email,
          subject: "Your Wezesha Restock sign-in code",
          text: `Your sign-in code is ${otp}. It expires in 5 minutes.`,
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

/**
 * The user's active workspace: earliest membership, single-workspace
 * assumption for now (a workspace switcher will own this choice). Runs on the
 * service client — membership resolution is the auth bootstrap step that
 * happens before any tenant scope exists.
 */
export async function activeMembership(userId: string) {
  return prismaService.membership.findFirst({
    where: { userId },
    orderBy: { createdAt: "asc" },
    include: { tenant: true },
  });
}
