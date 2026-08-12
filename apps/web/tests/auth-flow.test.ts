import { afterAll, describe, expect, it } from "vitest";

/**
 * End-to-end auth flow through the real route handler against the local
 * database: signup → session cookie → sign-in → get-session. Skips when no
 * local service connection is configured.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const EMAIL = "auth-flow-test@example.test";
const STRANGER = "auth-flow-stranger@example.test";
const PASSWORD = "auth-flow-pass-1";
const base = "http://auth-flow.test";

function post(path: string, body: unknown, cookie?: string): Request {
  return new Request(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: base,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function sessionCookie(res: Response): string {
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = /better-auth\.session_token=[^;]+/.exec(setCookie);
  expect(match, `expected a session cookie, got: ${setCookie}`).toBeTruthy();
  return match![0];
}

describe.skipIf(!runnable)("auth flow (route handler + local db)", () => {
  afterAll(async () => {
    const { prismaService } = await import("@wezesha/db");
    await prismaService.user.deleteMany({ where: { email: { in: [EMAIL, STRANGER] } } });
    await prismaService.$disconnect();
  });

  it("signs up with email+password and starts a session", async () => {
    const { POST } = await import("../app/api/auth/[...all]/route");
    const { prismaService } = await import("@wezesha/db");
    await prismaService.user.deleteMany({ where: { email: EMAIL } });

    const res = await POST(
      post("/api/auth/sign-up/email", {
        email: EMAIL,
        password: PASSWORD,
        name: "auth-flow-test",
      })
    );
    expect(res.status).toBe(200);
    const cookie = sessionCookie(res);
    expect(cookie.length).toBeGreaterThan("better-auth.session_token=".length);

    const user = await prismaService.user.findUnique({ where: { email: EMAIL } });
    expect(user?.name).toBe("auth-flow-test");
  });

  it("rejects passwords under the 8-character minimum", async () => {
    const { POST } = await import("../app/api/auth/[...all]/route");
    const res = await POST(
      post("/api/auth/sign-up/email", {
        email: "auth-flow-short@example.test",
        password: "short1!",
        name: "too-short",
      })
    );
    expect(res.status).toBe(400);
  });

  it("rejects a wrong password on sign-in", async () => {
    const { POST } = await import("../app/api/auth/[...all]/route");
    const res = await POST(
      post("/api/auth/sign-in/email", { email: EMAIL, password: "wrong-password-1" })
    );
    expect(res.status).toBe(401);
  });

  it("signs in and returns the session for its cookie", async () => {
    const { GET, POST } = await import("../app/api/auth/[...all]/route");
    const signIn = await POST(
      post("/api/auth/sign-in/email", { email: EMAIL, password: PASSWORD })
    );
    expect(signIn.status).toBe(200);
    const cookie = sessionCookie(signIn);

    const res = await GET(
      new Request(`${base}/api/auth/get-session`, { headers: { cookie } })
    );
    expect(res.status).toBe(200);
    const session = (await res.json()) as { user?: { email: string } } | null;
    expect(session?.user?.email).toBe(EMAIL);
  });

  it("rejects get-session with no cookie", async () => {
    const { GET } = await import("../app/api/auth/[...all]/route");
    const res = await GET(new Request(`${base}/api/auth/get-session`));
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  it("a sign-in code for an unknown address creates no account", async () => {
    // The OTP plugin signs up by default: it mails a code to any address and
    // creates the User when that code is REDEEMED. Account creation with no
    // authentication in front of it, plus an unmetered way to make us send mail
    // to a stranger.
    //
    // Requesting the code is not the step that creates anything, so the test has
    // to redeem it — an earlier version asserted after the send alone and passed
    // against the unfixed code, proving nothing. The pending OTP is readable
    // from the Verification table ("<otp>:<attempts>").
    const { POST } = await import("../app/api/auth/[...all]/route");
    const { prismaService } = await import("@wezesha/db");
    await prismaService.user.deleteMany({ where: { email: STRANGER } });
    await prismaService.verification.deleteMany({
      where: { identifier: { contains: STRANGER } },
    });

    await POST(
      post("/api/auth/email-otp/send-verification-otp", { email: STRANGER, type: "sign-in" })
    );

    // Nothing is issued at all now, which closes the mail vector as well as the
    // account one. Before the fix a code WAS issued here and redeeming it
    // returned 200 with a session — that is what this asserts against.
    const pending = await prismaService.verification.findFirst({
      where: { identifier: { contains: STRANGER } },
      orderBy: { createdAt: "desc" },
    });
    expect(pending, "a sign-in code was issued for an address with no account").toBeNull();
    expect(await prismaService.user.count({ where: { email: STRANGER } })).toBe(0);

    // Vacuity guard: the endpoint must still work for a real account, or this
    // would also pass with OTP sign-in broken outright.
    await prismaService.verification.deleteMany({ where: { identifier: { contains: EMAIL } } });
    await POST(post("/api/auth/email-otp/send-verification-otp", { email: EMAIL, type: "sign-in" }));
    expect(
      await prismaService.verification.findFirst({ where: { identifier: { contains: EMAIL } } })
    ).toBeTruthy();
  });
});
