import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { verifyOAuthHmac, verifyWebhookHmac } from "../src/hmac";

const SECRET = "shpss_test_secret";

function webhookSign(body: string): string {
  return crypto.createHmac("sha256", SECRET).update(body).digest("base64");
}

describe("verifyWebhookHmac", () => {
  const body = JSON.stringify({ id: 123, title: "Product" });

  it("accepts a correctly signed raw body", () => {
    expect(verifyWebhookHmac(body, webhookSign(body), SECRET)).toBe(true);
  });

  it("rejects a signature over different bytes", () => {
    expect(verifyWebhookHmac(body + " ", webhookSign(body), SECRET)).toBe(false);
  });

  it("rejects a signature under the wrong secret", () => {
    const wrong = crypto.createHmac("sha256", "other-secret").update(body).digest("base64");
    expect(verifyWebhookHmac(body, wrong, SECRET)).toBe(false);
  });

  it("rejects an empty/garbage header", () => {
    expect(verifyWebhookHmac(body, "", SECRET)).toBe(false);
    expect(verifyWebhookHmac(body, "!!!not-base64!!!", SECRET)).toBe(false);
  });
});

function oauthSign(params: Record<string, string>): string {
  const pairs = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  return crypto.createHmac("sha256", SECRET).update(pairs.join("&")).digest("hex");
}

describe("verifyOAuthHmac", () => {
  const base = {
    code: "authcode123",
    shop: "example-store.myshopify.com",
    state: "abcdef0123456789",
    timestamp: "1750000000",
  };

  it("accepts a correctly signed callback query", () => {
    const params = new URLSearchParams({ ...base, hmac: oauthSign(base) });
    expect(verifyOAuthHmac(params, SECRET)).toBe(true);
  });

  it("sorts parameters regardless of arrival order", () => {
    const params = new URLSearchParams();
    params.set("timestamp", base.timestamp);
    params.set("shop", base.shop);
    params.set("state", base.state);
    params.set("code", base.code);
    params.set("hmac", oauthSign(base));
    expect(verifyOAuthHmac(params, SECRET)).toBe(true);
  });

  it("excludes the signature parameter like hmac", () => {
    const params = new URLSearchParams({ ...base, hmac: oauthSign(base), signature: "legacy" });
    expect(verifyOAuthHmac(params, SECRET)).toBe(true);
  });

  it("rejects when any parameter was altered", () => {
    const params = new URLSearchParams({ ...base, shop: "evil.myshopify.com", hmac: oauthSign(base) });
    expect(verifyOAuthHmac(params, SECRET)).toBe(false);
  });

  it("rejects a missing hmac", () => {
    expect(verifyOAuthHmac(new URLSearchParams(base), SECRET)).toBe(false);
  });
});
