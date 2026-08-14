import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The ledger only answers "did that go out?" if the callers say who it was for
 * and what it was. A row with a null tenant and no kind is a row nobody can
 * filter, and the workspace export (EmailLog is in it) would carry none of it.
 *
 * So these drive the real call paths — the invite helper and the auth route
 * handler — and read the row back, rather than checking the source for a
 * property name: passing the wrong tenant is the failure that would hurt, and
 * only the written row can catch it.
 *
 * Two of the three sends have no tenant on purpose. A password reset and a
 * sign-in code are addressed to a person before any workspace is resolved (a
 * user may belong to several, or none yet), so the honest value is null and the
 * kind is what makes the row useful.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const SLUG = "email-caller-tenant";
const OWNER = "email-caller-owner@example.test";
const INVITEE = "email-caller-invitee@example.test";
const PASSWORD = "email-caller-pass-1";
const base = "http://auth-flow.test";

function post(path: string, body: unknown): Request {
  return new Request(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!runnable)("outbound mail names its tenant and kind (local db)", () => {
  let prismaService: typeof import("@wezesha/db").prismaService;
  let tenantId: string;

  const original = { key: process.env.RESEND_API_KEY, from: process.env.EMAIL_FROM };

  beforeAll(async () => {
    ({ prismaService } = await import("@wezesha/db"));
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    const tenant = await prismaService.tenant.create({
      data: { name: "Email Caller Shop", slug: SLUG },
    });
    tenantId = tenant.id;

    // A real account, so the sign-in code and reset paths have someone to mail.
    await prismaService.user.deleteMany({ where: { email: OWNER } });
    const { POST } = await import("../app/api/auth/[...all]/route");
    const res = await POST(
      post("/api/auth/sign-up/email", { email: OWNER, password: PASSWORD, name: "email caller" }),
    );
    expect(res.status).toBe(200);
  }, 30_000);

  afterAll(async () => {
    await prismaService.emailLog.deleteMany({ where: { to: { in: [OWNER, INVITEE] } } });
    await prismaService.user.deleteMany({ where: { email: OWNER } });
    await prismaService.tenant.deleteMany({ where: { id: tenantId } });
    await prismaService.$disconnect();
  }, 30_000);

  beforeEach(async () => {
    // No provider key: the send takes the console fallback, which still writes
    // the envelope. The row is what these assert on, not the delivery.
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
    await prismaService.emailLog.deleteMany({ where: { to: { in: [OWNER, INVITEE] } } });
  });

  afterEach(() => {
    process.env.RESEND_API_KEY = original.key;
    process.env.EMAIL_FROM = original.from;
  });

  /** The one row this send left, waiting briefly for a best-effort write. */
  async function rowFor(to: string) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const rows = await prismaService.emailLog.findMany({ where: { to } });
      if (rows.length > 0) {
        expect(rows).toHaveLength(1);
        return rows[0]!;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`no EmailLog row was written for ${to}`);
  }

  it("logs a teammate invite against the workspace that sent it", async () => {
    const { createInvite, sendInviteEmail } = await import("../lib/auth/invites");
    const created = await createInvite({ tenantId, email: INVITEE, role: "MEMBER" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await sendInviteEmail({
      invite: created.invite,
      tenantName: "Email Caller Shop",
      invitedBy: "the owner",
    });

    const row = await rowFor(INVITEE);
    expect(row.tenantId).toBe(tenantId);
    expect(row.kind).toBe("invite");
  });

  it("logs a password reset with no tenant, but with its kind", async () => {
    const { POST } = await import("../app/api/auth/[...all]/route");
    const res = await POST(
      post("/api/auth/request-password-reset", { email: OWNER, redirectTo: "/reset-password" }),
    );
    expect(res.status).toBe(200);

    const row = await rowFor(OWNER);
    expect(row.tenantId).toBeNull();
    expect(row.kind).toBe("password_reset");
  });

  it("logs a sign-in code with no tenant, but with its kind", async () => {
    const { POST } = await import("../app/api/auth/[...all]/route");
    const res = await POST(
      post("/api/auth/email-otp/send-verification-otp", { email: OWNER, type: "sign-in" }),
    );
    expect(res.status).toBe(200);

    const row = await rowFor(OWNER);
    expect(row.tenantId).toBeNull();
    expect(row.kind).toBe("sign_in_code");
  });
});
