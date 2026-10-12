import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendEmail, type MailTransport } from "../lib/email";

/**
 * The outbound seam in isolation: with a key it hands the right message to the
 * injected Brevo transport (including the rich html body PO emails carry);
 * without one it falls back to console and never sends. No real SMTP — the
 * transport is always a fake.
 */

function okTransport(id = "brevo-1") {
  return { sendMail: vi.fn<MailTransport["sendMail"]>(async () => ({ messageId: id })) } satisfies MailTransport;
}

const KEY = "test-brevo-key";

describe("web sendEmail", () => {
  const original = {
    key: process.env.BREVO_SMTP_KEY,
    from: process.env.EMAIL_FROM,
    replyTo: process.env.EMAIL_REPLY_TO,
  };

  beforeEach(() => {
    delete process.env.BREVO_SMTP_KEY;
    delete process.env.EMAIL_FROM;
    delete process.env.EMAIL_REPLY_TO;
  });

  afterEach(() => {
    process.env.BREVO_SMTP_KEY = original.key;
    process.env.EMAIL_FROM = original.from;
    process.env.EMAIL_REPLY_TO = original.replyTo;
    vi.restoreAllMocks();
  });

  it("hands the transport the sender, recipient and an html body when a key is set", async () => {
    process.env.BREVO_SMTP_KEY = KEY;
    process.env.EMAIL_FROM = "Wezesha Restock <no-reply@wezesha.test>";
    const transport = okTransport();

    await sendEmail(
      {
        to: "supplier@example.test",
        subject: "Purchase order PO-1001",
        text: "Plain-text PO",
        html: "<h1>PO-1001</h1>",
      },
      transport,
    );

    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    expect(transport.sendMail).toHaveBeenCalledWith({
      from: "Wezesha Restock <no-reply@wezesha.test>",
      to: "supplier@example.test",
      subject: "Purchase order PO-1001",
      text: "Plain-text PO",
      html: "<h1>PO-1001</h1>",
    });
  });

  it("routes replies to EMAIL_REPLY_TO while sending From the authenticated domain", async () => {
    // The From must stay on the verified domain (Brevo rejects an unverifiable
    // sender; Gmail's DMARC bounces a gmail.com From). Reply-To is how a team
    // still collects replies in a Gmail inbox.
    process.env.BREVO_SMTP_KEY = KEY;
    process.env.EMAIL_FROM = "Wezesha Restock <no-reply@wezesha.test>";
    process.env.EMAIL_REPLY_TO = "teamsimplydone@gmail.com";
    const transport = okTransport();

    await sendEmail({ to: "user@example.test", subject: "Hi", text: "body" }, transport);

    const msg = transport.sendMail.mock.calls[0]![0];
    expect(msg.from).toBe("Wezesha Restock <no-reply@wezesha.test>");
    expect(msg.replyTo).toBe("teamsimplydone@gmail.com");
  });

  it("lets a per-message replyTo override the env default", async () => {
    process.env.BREVO_SMTP_KEY = KEY;
    process.env.EMAIL_FROM = "no-reply@wezesha.test";
    process.env.EMAIL_REPLY_TO = "default@wezesha.test";
    const transport = okTransport();

    await sendEmail(
      { to: "user@example.test", subject: "Hi", text: "body", replyTo: "specific@wezesha.test" },
      transport,
    );

    expect(transport.sendMail.mock.calls[0]![0].replyTo).toBe("specific@wezesha.test");
  });

  it("omits the html body for text-only messages", async () => {
    process.env.BREVO_SMTP_KEY = KEY;
    process.env.EMAIL_FROM = "no-reply@wezesha.test";
    const transport = okTransport();

    await sendEmail({ to: "user@example.test", subject: "Your code", text: "123456" }, transport);

    const msg = transport.sendMail.mock.calls[0]![0];
    expect(msg).not.toHaveProperty("html");
    expect(msg.from).toBe("no-reply@wezesha.test");
    expect(msg.to).toBe("user@example.test");
  });

  it("falls back to console and does not send without a key", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const transport = okTransport();

    // No key AND no injected transport -> console fallback. (Passing a transport
    // counts as "configured", so this test passes none.)
    await expect(
      sendEmail({ to: "user@example.test", subject: "Your code", text: "123456" }),
    ).resolves.toBe("skipped");

    expect(transport.sendMail).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no BREVO_SMTP_KEY"));
  });

  it("throws a clear error when the key is set but EMAIL_FROM is missing", async () => {
    process.env.BREVO_SMTP_KEY = KEY;
    const transport = okTransport();

    await expect(
      sendEmail({ to: "user@example.test", subject: "Hi", text: "body" }, transport),
    ).rejects.toThrow(/EMAIL_FROM is not set/);
    expect(transport.sendMail).not.toHaveBeenCalled();
  });

  it("throws when Brevo rejects the send", async () => {
    process.env.BREVO_SMTP_KEY = KEY;
    process.env.EMAIL_FROM = "no-reply@wezesha.test";
    const failing: MailTransport = {
      sendMail: vi.fn(async () => {
        throw new Error("550 relay denied");
      }),
    };

    await expect(
      sendEmail({ to: "user@example.test", subject: "Hi", text: "body" }, failing),
    ).rejects.toThrow(/Brevo send failed/);
  });
});
