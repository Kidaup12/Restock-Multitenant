import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sendEmail } from "../src/email";

/**
 * The worker half of the outbound seam, held to the same promise as the web
 * half: a production worker with no provider key refuses the send rather than
 * returning as though the reconnect alert went out, every attempt leaves one
 * EmailLog row, and outside production the console fallback still resolves.
 */

function okFetch(status = 201, id = "resend-message-id") {
  return vi.fn(async () => ({
    ok: status < 400,
    status,
    json: async () => ({ id }),
    text: async () => "",
  })) as unknown as typeof fetch;
}

const KEY = "test-resend-key";
const FROM = "Wezesha Restock <alerts@wezesha.test>";

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const SLUG = "worker-email-log-tenant";

describe.skipIf(!runnable)("worker email log + missing-key behaviour (local db)", () => {
  let prismaService: typeof import("@wezesha/db").prismaService;
  let tenantId: string;

  const original = { key: process.env.RESEND_API_KEY, from: process.env.EMAIL_FROM };

  beforeAll(async () => {
    ({ prismaService } = await import("@wezesha/db"));
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    const tenant = await prismaService.tenant.create({
      data: { name: "Worker Email Log", slug: SLUG },
    });
    tenantId = tenant.id;
  }, 30_000);

  afterAll(async () => {
    await prismaService.emailLog.deleteMany({ where: { tenantId } });
    await prismaService.tenant.deleteMany({ where: { id: tenantId } });
    await prismaService.$disconnect();
  }, 30_000);

  beforeEach(async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
    vi.unstubAllEnvs();
    await prismaService.emailLog.deleteMany({ where: { tenantId } });
  });

  afterEach(() => {
    process.env.RESEND_API_KEY = original.key;
    process.env.EMAIL_FROM = original.from;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("refuses to send in production when the provider key is missing", async () => {
    vi.stubEnv("NODE_ENV", "production");

    await expect(
      sendEmail({ to: "owner@shop.test", subject: "Action needed", text: "Sync failing." }, okFetch()),
    ).rejects.toThrow(/RESEND_API_KEY/);
  });

  it("still resolves outside production so local dev keeps working", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchMock = okFetch();

    await expect(
      sendEmail({ to: "owner@shop.test", subject: "Hi", text: "body" }, fetchMock),
    ).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no RESEND_API_KEY"));
  });

  it("writes exactly one 'sent' row after a successful send", async () => {
    process.env.RESEND_API_KEY = KEY;
    process.env.EMAIL_FROM = FROM;

    await sendEmail(
      {
        to: "owner@shop.test",
        subject: "Reconnect your store",
        text: "Sync is failing.",
        tenantId,
        kind: "reconnect_alert",
      },
      okFetch(),
    );

    const rows = await prismaService.emailLog.findMany({ where: { tenantId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("sent");
    expect(rows[0]!.to).toBe("owner@shop.test");
    expect(rows[0]!.kind).toBe("reconnect_alert");
    expect(rows[0]!.providerId).toBe("resend-message-id");
  });

  it("records a failed send with the provider's reason, and still throws", async () => {
    process.env.RESEND_API_KEY = KEY;
    process.env.EMAIL_FROM = FROM;

    await expect(
      sendEmail({ to: "owner@shop.test", subject: "Hi", text: "body", tenantId }, okFetch(401)),
    ).rejects.toThrow(/Resend send failed \(401\)/);

    const rows = await prismaService.emailLog.findMany({ where: { tenantId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.error).toMatch(/401/);
  });

  it("a logging failure never fails an otherwise successful send", async () => {
    process.env.RESEND_API_KEY = KEY;
    process.env.EMAIL_FROM = FROM;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(prismaService.emailLog, "create").mockRejectedValue(new Error("db down"));
    const fetchMock = okFetch();

    await expect(
      sendEmail({ to: "owner@shop.test", subject: "Hi", text: "body", tenantId }, fetchMock),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
