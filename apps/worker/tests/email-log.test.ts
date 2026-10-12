import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sendEmail, type MailTransport } from "../src/email";

/**
 * The worker half of the outbound seam, held to the same promise as the web
 * half: a production worker with no provider key refuses the send rather than
 * returning as though the reconnect alert went out, every attempt leaves one
 * EmailLog row, and outside production the console fallback still resolves.
 */

/** A Brevo transport that accepts every send, standing in for a real relay. */
function okTransport(id = "brevo-message-id") {
  return { sendMail: vi.fn(async () => ({ messageId: id })) } satisfies MailTransport;
}

const KEY = "test-brevo-key";
const FROM = "Wezesha Restock <alerts@wezesha.test>";

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const SLUG = "worker-email-log-tenant";

describe.skipIf(!runnable)("worker email log + missing-key behaviour (local db)", () => {
  let prismaService: typeof import("@wezesha/db").prismaService;
  let tenantId: string;

  const original = { key: process.env.BREVO_SMTP_KEY, from: process.env.EMAIL_FROM };

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
    delete process.env.BREVO_SMTP_KEY;
    delete process.env.EMAIL_FROM;
    vi.unstubAllEnvs();
    await prismaService.emailLog.deleteMany({ where: { tenantId } });
  });

  afterEach(() => {
    process.env.BREVO_SMTP_KEY = original.key;
    process.env.EMAIL_FROM = original.from;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("refuses to send in production when the provider key is missing", async () => {
    vi.stubEnv("NODE_ENV", "production");

    // No key AND no injected transport -> production hard-fails.
    await expect(
      sendEmail({ to: "owner@shop.test", subject: "Action needed", text: "Sync failing." }),
    ).rejects.toThrow(/BREVO_SMTP_KEY/);
  });

  it("still resolves outside production so local dev keeps working", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    // No key and no transport -> the console fallback.
    await expect(
      sendEmail({ to: "owner@shop.test", subject: "Hi", text: "body" }),
    ).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledWith(expect.stringContaining("no BREVO_SMTP_KEY"));
  });

  it("writes exactly one 'sent' row after a successful send", async () => {
    process.env.BREVO_SMTP_KEY = KEY;
    process.env.EMAIL_FROM = FROM;

    await sendEmail(
      {
        to: "owner@shop.test",
        subject: "Reconnect your store",
        text: "Sync is failing.",
        tenantId,
        kind: "reconnect_alert",
      },
      okTransport(),
    );

    const rows = await prismaService.emailLog.findMany({ where: { tenantId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("sent");
    expect(rows[0]!.to).toBe("owner@shop.test");
    expect(rows[0]!.kind).toBe("reconnect_alert");
    // The provider id is now the nodemailer messageId, not Resend's json .id.
    expect(rows[0]!.providerId).toBe("brevo-message-id");
  });

  it("records a failed send with the provider's reason, and still throws", async () => {
    process.env.BREVO_SMTP_KEY = KEY;
    process.env.EMAIL_FROM = FROM;
    // A failing send is now a transport whose sendMail throws (SMTP rejection),
    // not an HTTP 401.
    const failing: MailTransport = {
      sendMail: vi.fn(async () => {
        throw new Error("401 unauthorized");
      }),
    };

    await expect(
      sendEmail({ to: "owner@shop.test", subject: "Hi", text: "body", tenantId }, failing),
    ).rejects.toThrow(/Brevo send failed/);

    const rows = await prismaService.emailLog.findMany({ where: { tenantId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.error).toMatch(/unauthorized/);
  });

  it("a logging failure never fails an otherwise successful send", async () => {
    process.env.BREVO_SMTP_KEY = KEY;
    process.env.EMAIL_FROM = FROM;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(prismaService.emailLog, "create").mockRejectedValue(new Error("db down"));
    const transport = okTransport();

    await expect(
      sendEmail({ to: "owner@shop.test", subject: "Hi", text: "body", tenantId }, transport),
    ).resolves.toBeUndefined();
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
  });
});
