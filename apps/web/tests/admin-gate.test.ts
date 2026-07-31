import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isAdminEmail, parseAdminEmails } from "../lib/admin/gate";

/**
 * The admin gate. Parsing is pure; the 404 posture and the table-versus-env
 * precedence are proven against the real /api/admin/sync handler with real
 * sessions from the local database (same harness as auth-flow) — a non-admin
 * must be indistinguishable from a missing page, whether signed in or not.
 *
 * The fallback question ("is the table empty?") is global by design, so this
 * suite owns that state for its duration: it parks any live rows another suite
 * or a local bootstrap left behind, and puts them back afterwards.
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

describe.skipIf(!runnable)("admin gate posture (real sessions)", () => {
  let prismaService: typeof import("@wezesha/db").prismaService;
  let syncPost: (req: Request) => Promise<Response>;
  let adminCookie: string;
  let civilianCookie: string;
  let civilianUserId: string;
  /** Live rows this suite parked so the table starts empty; restored in afterAll. */
  let parked: string[] = [];

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
    ({ prismaService } = await import("@wezesha/db"));
    await prismaService.user.deleteMany({
      where: { email: { in: [ADMIN_EMAIL, CIVILIAN_EMAIL] } },
    });
    ({ POST: syncPost } = await import("../app/api/admin/sync/route"));
    adminCookie = await signUp(ADMIN_EMAIL);
    civilianCookie = await signUp(CIVILIAN_EMAIL);

    const civilian = await prismaService.user.findFirstOrThrow({
      where: { email: CIVILIAN_EMAIL },
      select: { id: true },
    });
    civilianUserId = civilian.id;

    const live = await prismaService.platformAdmin.findMany({
      where: { revokedAt: null },
      select: { id: true },
    });
    parked = live.map((r) => r.id);
    await prismaService.platformAdmin.updateMany({
      where: { id: { in: parked } },
      data: { revokedAt: new Date() },
    });
  }, 30_000);

  beforeEach(async () => {
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;
    await prismaService.platformAdmin.deleteMany({ where: { userId: civilianUserId } });
  });

  afterAll(async () => {
    delete process.env.ADMIN_EMAILS;
    await prismaService.platformAdmin.deleteMany({ where: { userId: civilianUserId } });
    await prismaService.platformAdmin.updateMany({
      where: { id: { in: parked } },
      data: { revokedAt: null },
    });
    await prismaService.user.deleteMany({
      where: { email: { in: [ADMIN_EMAIL, CIVILIAN_EMAIL] } },
    });
    await prismaService.$disconnect();
  });

  it("404s with no session at all", async () => {
    expect((await syncPost(syncRequest())).status).toBe(404);
  });

  it("404s for a signed-in user who is neither in the table nor on the allow-list", async () => {
    expect((await syncPost(syncRequest(civilianCookie))).status).toBe(404);
  });

  it("404s for everyone when the table is empty and ADMIN_EMAILS is unset", async () => {
    // Both sources empty is the fail-closed case: no console for anybody.
    delete process.env.ADMIN_EMAILS;
    expect((await syncPost(syncRequest(adminCookie))).status).toBe(404);
  });

  it("falls back to ADMIN_EMAILS while the table is empty (400: bogus tenant, not 404)", async () => {
    expect((await syncPost(syncRequest(adminCookie))).status).toBe(400);
  });

  it("fallback matching is case-insensitive", async () => {
    process.env.ADMIN_EMAILS = ADMIN_EMAIL.toUpperCase();
    expect((await syncPost(syncRequest(adminCookie))).status).toBe(400);
  });

  it("a PlatformAdmin row grants access, and makes ADMIN_EMAILS inert", async () => {
    // The civilian is not on the allow-list; the admin is on it and NOT in the
    // table. One live row flips both of them — that is the whole point of the
    // env var being a bootstrap rather than a second, permanent door.
    await prismaService.platformAdmin.create({
      data: { userId: civilianUserId, email: CIVILIAN_EMAIL },
    });

    expect((await syncPost(syncRequest(civilianCookie))).status).toBe(400);
    expect((await syncPost(syncRequest(adminCookie))).status).toBe(404);
  });

  it("a revoked row grants nothing, and hands the question back to the env var", async () => {
    await prismaService.platformAdmin.create({
      data: { userId: civilianUserId, email: CIVILIAN_EMAIL, revokedAt: new Date() },
    });

    // Revocation takes effect on the next request, not when a cookie expires.
    expect((await syncPost(syncRequest(civilianCookie))).status).toBe(404);
    // And with no LIVE row left, the bootstrap answers again — which is what
    // stops a revoke-everyone from locking the console permanently.
    expect((await syncPost(syncRequest(adminCookie))).status).toBe(400);
  });
});
