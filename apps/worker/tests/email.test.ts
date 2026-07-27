import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendEmail } from "../src/email";

/**
 * The outbound seam in isolation: with a key it posts the right Resend request
 * over an injected fetch; without one it falls back to console and never calls
 * the network. No real network — the fetch is always a fake.
 */

type FetchArgs = Parameters<typeof fetch>;

function okFetch(status = 201) {
  return vi.fn(async (..._args: FetchArgs) => ({
    ok: status < 400,
    status,
    text: async () => "",
  })) as unknown as typeof fetch;
}

const KEY = "test-resend-key";

describe("worker sendEmail", () => {
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

  it("posts a text alert to Resend when a key is set", async () => {
    process.env.RESEND_API_KEY = KEY;
    process.env.EMAIL_FROM = "Wezesha Restock <alerts@wezesha.test>";
    const fetchMock = okFetch();

    await sendEmail(
      { to: "owner@shop.test", subject: "Action needed", text: "Sync is failing." },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({
      // Mirrors the web seam exactly — the two must not drift apart.
      from: "Wezesha Restock <alerts@wezesha.test>",
      to: ["owner@shop.test"],
      subject: "Action needed",
      text: "Sync is failing.",
    });
  });

  it("passes a bare EMAIL_FROM address through unchanged", async () => {
    process.env.RESEND_API_KEY = KEY;
    process.env.EMAIL_FROM = "alerts@wezesha.test";
    const fetchMock = okFetch();

    await sendEmail({ to: "owner@shop.test", subject: "Hi", text: "body" }, fetchMock);

    const [, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(JSON.parse(init.body).from).toBe("alerts@wezesha.test");
  });

  it("falls back to console and does not call fetch without a key", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchMock = okFetch();

    await expect(
      sendEmail({ to: "owner@shop.test", subject: "Hi", text: "body" }, fetchMock),
    ).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no RESEND_API_KEY"));
  });

  it("throws when Resend rejects the send", async () => {
    process.env.RESEND_API_KEY = KEY;
    process.env.EMAIL_FROM = "alerts@wezesha.test";

    await expect(
      sendEmail({ to: "owner@shop.test", subject: "Hi", text: "body" }, okFetch(401)),
    ).rejects.toThrow(/Resend send failed \(401\)/);
  });
});
