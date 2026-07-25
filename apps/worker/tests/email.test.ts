import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendEmail } from "../src/email";

/**
 * The outbound seam in isolation: with a key it posts the right Brevo request
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

const KEY = "test-brevo-key";

describe("worker sendEmail", () => {
  const original = { key: process.env.BREVO_API_KEY, from: process.env.EMAIL_FROM };

  beforeEach(() => {
    delete process.env.BREVO_API_KEY;
    delete process.env.EMAIL_FROM;
  });

  afterEach(() => {
    process.env.BREVO_API_KEY = original.key;
    process.env.EMAIL_FROM = original.from;
    vi.restoreAllMocks();
  });

  it("posts a text alert to Brevo when a key is set", async () => {
    process.env.BREVO_API_KEY = KEY;
    process.env.EMAIL_FROM = "Wezesha Restock <alerts@wezesha.test>";
    const fetchMock = okFetch();

    await sendEmail(
      { to: "owner@shop.test", subject: "Action needed", text: "Sync is failing." },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("https://api.brevo.com/v3/smtp/email");
    expect(init.method).toBe("POST");
    expect(init.headers["api-key"]).toBe(KEY);
    expect(init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({
      sender: { name: "Wezesha Restock", email: "alerts@wezesha.test" },
      to: [{ email: "owner@shop.test" }],
      subject: "Action needed",
      textContent: "Sync is failing.",
    });
  });

  it("parses a bare EMAIL_FROM address", async () => {
    process.env.BREVO_API_KEY = KEY;
    process.env.EMAIL_FROM = "alerts@wezesha.test";
    const fetchMock = okFetch();

    await sendEmail({ to: "owner@shop.test", subject: "Hi", text: "body" }, fetchMock);

    const [, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(JSON.parse(init.body).sender).toEqual({ email: "alerts@wezesha.test" });
  });

  it("falls back to console and does not call fetch without a key", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchMock = okFetch();

    await expect(
      sendEmail({ to: "owner@shop.test", subject: "Hi", text: "body" }, fetchMock),
    ).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no BREVO_API_KEY"));
  });

  it("throws when Brevo rejects the send", async () => {
    process.env.BREVO_API_KEY = KEY;
    process.env.EMAIL_FROM = "alerts@wezesha.test";

    await expect(
      sendEmail({ to: "owner@shop.test", subject: "Hi", text: "body" }, okFetch(401)),
    ).rejects.toThrow(/Brevo send failed \(401\)/);
  });
});
