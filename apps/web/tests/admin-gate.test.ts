import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { isAdminEmail, parseAdminEmails } from "../lib/admin/gate";

/**
 * The admin allow-list gate. Parsing is pure; the 404 posture is proven
 * against the real /api/admin/sync handler with real sessions from the local
 * database (same harness as auth-flow) — a non-admin must be indistinguishable
 * from a missing page, whether signed in or not.
 */

const dbUrl = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(dbUrl);

const ADMIN_EMAIL = "admin-gate-admin@example.test";
const CIVILIAN_EMAIL = "admin-gate-civilian@example.test";
const PASSWORD = "admin-gate-pass-1";
const base = "http://auth-flow.test";

describe("ADMIN_EMAILS parsing", () => {
  afterEach(() => {
    delete process.env.ADMIN_EMAILS;
  });

  it("splits on commas, trims, and lowercases", () => {
    expect(parseAdminEmails(" Ops@Example.com ,  dave@example.com,")).toEqual([
      "ops@example.com",
      "dave@example.com",
    ]);
  });

  it("unset or empty means nobody is an admin", () => {
    expect(parseAdminEmails(undefined)).toEqual([]);
    expect(parseAdminEmails("")).toEqual([]);
    expect(parseAdminEmails(" , ,")).toEqual([]);
    expect(isAdminEmail("anyone@example.com")).toBe(false);
  });

  it("matches case-insensitively on both sides", () => {
    process.env.ADMIN_EMAILS = "Ops@Example.com";
    expect(isAdminEmail("ops@example.com")).toBe(true);
    expect(isAdminEmail("OPS@EXAMPLE.COM")).toBe(true);
    expect(isAdminEmail("other@example.com")).toBe(false);
  });

  it("never matches null/undefined/empty emails", () => {
    process.env.ADMIN_EMAILS = "ops@example.com";
    expect(isAdminEmail(null)).toBe(false);
    expect(isAdminEmail(undefined)).toBe(false);
    expect(isAdminEmail("")).toBe(false);
  });
});

describe.skipIf(!runnable)("admin route 404 posture (real sessions)", () => {
  let syncPost: (req: Request) => Promise<Response>;
  let adminCookie: string;
  let civilianCookie: string;

  async function signUp(email: string): Promise<string> {
    const { POST } = await import("../app/api/auth/[...all]/route");
    const res = await POST(
      new Request(`${base}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({ email, password: PASSWORD, name: email.split("@")[0] }),
      })
    );
    expect(res.status).toBe(200);
    const match = /better-auth\.session_token=[^;]+/.exec(res.headers.get("set-cookie") ?? "");
    expect(match).toBeTruthy();
    return match![0];
  }

  function syncRequest(cookie?: string): Request {
    return new Request(`${base}/api/admin/sync`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({ tenantId: "irrelevant" }),
    });
  }

  beforeAll(async () => {
    const { prismaService } = await import("@wezesha/db");
    await prismaService.user.deleteMany({
      where: { email: { in: [ADMIN_EMAIL, CIVILIAN_EMAIL] } },
    });
    ({ POST: syncPost } = await import("../app/api/admin/sync/route"));
    adminCookie = await signUp(ADMIN_EMAIL);
    civilianCookie = await signUp(CIVILIAN_EMAIL);
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;
  }, 30_000);

  afterAll(async () => {
    delete process.env.ADMIN_EMAILS;
    const { prismaService } = await import("@wezesha/db");
    await prismaService.user.deleteMany({
      where: { email: { in: [ADMIN_EMAIL, CIVILIAN_EMAIL] } },
    });
    await prismaService.$disconnect();
  });

  it("404s with no session at all", async () => {
    expect((await syncPost(syncRequest())).status).toBe(404);
  });

  it("404s for a signed-in user who is not on the allow-list", async () => {
    expect((await syncPost(syncRequest(civilianCookie))).status).toBe(404);
  });

  it("404s for everyone when ADMIN_EMAILS is unset", async () => {
    delete process.env.ADMIN_EMAILS;
    expect((await syncPost(syncRequest(adminCookie))).status).toBe(404);
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;
  });

  it("lets an allow-listed admin past the gate (400: bogus tenant, not 404)", async () => {
    expect((await syncPost(syncRequest(adminCookie))).status).toBe(400);
  });

  it("allow-list matching for the gate is case-insensitive", async () => {
    process.env.ADMIN_EMAILS = ADMIN_EMAIL.toUpperCase();
    expect((await syncPost(syncRequest(adminCookie))).status).toBe(400);
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;
  });
});
