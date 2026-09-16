import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendEmail, type MailTransport } from "../src/email";

/**
 * The outbound seam in isolation: with a key it hands the right message to the
 * injected Brevo transport; without one it falls back to console and never
 * sends. No real SMTP — the transport is always a fake. This seam returns void
 * (not an outcome), so there is no "sent"/"skipped" to read; the assertions are
 * on the transport it drove and on whether it resolved or threw.
 */

function okTransport(id = "brevo-1") {
  return { sendMail: vi.fn<MailTransport["sendMail"]>(async () => ({ messageId: id })) } satisfies MailTransport;
}

const KEY = "test-brevo-key";

describe("worker sendEmail", () => {
  const original = { key: process.env.BREVO_SMTP_KEY, from: process.env.EMAIL_FROM };

  beforeEach(() => {
    delete process.env.BREVO_SMTP_KEY;
    delete process.env.EMAIL_FROM;
  });

  afterEach(() => {
    process.env.BREVO_SMTP_KEY = original.key;
    process.env.EMAIL_FROM = original.from;
    vi.restoreAllMocks();
  });

  it("hands the transport the sender, recipient and text alert when a key is set", async () => {
    process.env.BREVO_SMTP_KEY = KEY;
    process.env.EMAIL_FROM = "Wezesha Restock <alerts@wezesha.test>";
    const transport = okTransport();

    await sendEmail(
      { to: "owner@shop.test", subject: "Action needed", text: "Sync is failing." },
      transport,
    );

    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    // Mirrors the web seam exactly — the two must not drift apart. Worker mail
    // carries no attachments.
    expect(transport.sendMail).toHaveBeenCalledWith({
      from: "Wezesha Restock <alerts@wezesha.test>",
      to: "owner@shop.test",
      subject: "Action needed",
      text: "Sync is failing.",
    });
  });

  it("passes a bare EMAIL_FROM address through unchanged", async () => {
    process.env.BREVO_SMTP_KEY = KEY;
    process.env.EMAIL_FROM = "alerts@wezesha.test";
    const transport = okTransport();

    await sendEmail({ to: "owner@shop.test", subject: "Hi", text: "body" }, transport);

    expect(transport.sendMail.mock.calls[0]![0].from).toBe("alerts@wezesha.test");
  });

  it("falls back to console and does not send without a key", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const transport = okTransport();

    // No key AND no injected transport -> console fallback. (Passing a transport
    // counts as "configured", so this test passes none.)
    await expect(
      sendEmail({ to: "owner@shop.test", subject: "Hi", text: "body" }),
    ).resolves.toBeUndefined();

    expect(transport.sendMail).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no BREVO_SMTP_KEY"));
  });

  it("throws when Brevo rejects the send", async () => {
    process.env.BREVO_SMTP_KEY = KEY;
    process.env.EMAIL_FROM = "alerts@wezesha.test";
    const failing: MailTransport = {
      sendMail: vi.fn(async () => {
        throw new Error("401 unauthorized");
      }),
    };

    await expect(
      sendEmail({ to: "owner@shop.test", subject: "Hi", text: "body" }, failing),
    ).rejects.toThrow(/Brevo send failed/);
  });
});
