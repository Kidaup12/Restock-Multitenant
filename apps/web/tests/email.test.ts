import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendEmail } from "../lib/email";

/**
 * The outbound seam in isolation: with a key it posts the right Resend request
 * over an injected fetch (including the rich html body PO emails carry);
 * without one it falls back to console and never calls the network. No real
 * network — the fetch is always a fake.
 */

function okFetch(status = 201) {
  return vi.fn(async () => ({
    ok: status < 400,
    status,
    text: async () => "",
  })) as unknown as typeof fetch;
}

const KEY = "test-resend-key";

describe("web sendEmail", () => {
  const original = { key: process.env.RESEND_API_KEY, from: process.env.EMAIL_FROM };

  beforeEach(() => {
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
  });

  afterEach(() => {
    process.env.RESEND_API_KEY = original.key;
    process.env.EMAIL_FROM = original.from;
    vi.restoreAllMocks();
  });

  it("posts to Resend with headers and an html body when a key is set", async () => {
    process.env.RESEND_API_KEY = KEY;
    process.env.EMAIL_FROM = "Wezesha Restock <no-reply@wezesha.test>";
    const fetchMock = okFetch();

    await sendEmail(
      {
        to: "supplier@example.test",
        subject: "Purchase order PO-1001",
        text: "Plain-text PO",
        html: "<h1>PO-1001</h1>",
      },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({
      // The sender passes through as written — Resend takes one RFC-5322 string.
      from: "Wezesha Restock <no-reply@wezesha.test>",
      to: ["supplier@example.test"],
      subject: "Purchase order PO-1001",
      text: "Plain-text PO",
      html: "<h1>PO-1001</h1>",
    });
  });

  it("omits the html body for text-only messages", async () => {
    process.env.RESEND_API_KEY = KEY;
    process.env.EMAIL_FROM = "no-reply@wezesha.test";
    const fetchMock = okFetch();

    await sendEmail({ to: "user@example.test", subject: "Your code", text: "123456" }, fetchMock);

    const [, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(init.body);
    expect(body).not.toHaveProperty("html");
    expect(body.from).toBe("no-reply@wezesha.test");
    expect(body.to).toEqual(["user@example.test"]);
  });

  it("never puts the api key anywhere but the authorization header", async () => {
    process.env.RESEND_API_KEY = KEY;
    process.env.EMAIL_FROM = "no-reply@wezesha.test";
    const fetchMock = okFetch();

    await sendEmail({ to: "user@example.test", subject: "Your code", text: "123456" }, fetchMock);

    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).not.toContain(KEY);
    expect(init.body).not.toContain(KEY);
  });

  it("falls back to console and does not call fetch without a key", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchMock = okFetch();

    await expect(
      sendEmail({ to: "user@example.test", subject: "Your code", text: "123456" }, fetchMock),
    ).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no RESEND_API_KEY"));
  });

  it("throws a clear error when the key is set but EMAIL_FROM is missing", async () => {
    process.env.RESEND_API_KEY = KEY;
    const fetchMock = okFetch();

    await expect(
      sendEmail({ to: "user@example.test", subject: "Hi", text: "body" }, fetchMock),
    ).rejects.toThrow(/EMAIL_FROM is not set/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when Resend rejects the send", async () => {
    process.env.RESEND_API_KEY = KEY;
    process.env.EMAIL_FROM = "no-reply@wezesha.test";

    await expect(
      sendEmail({ to: "user@example.test", subject: "Hi", text: "body" }, okFetch(400)),
    ).rejects.toThrow(/Resend send failed \(400\)/);
  });
});
