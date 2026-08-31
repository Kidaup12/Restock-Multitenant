import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { decryptToken, encryptToken } from "../src/crypto";

const KEY = crypto.randomBytes(32).toString("base64");
let prevKey: string | undefined;

beforeAll(() => {
  prevKey = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.TOKEN_ENCRYPTION_KEY = KEY;
});

afterAll(() => {
  if (prevKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
  else process.env.TOKEN_ENCRYPTION_KEY = prevKey;
});

describe("token crypto (AES-256-GCM)", () => {
  it("round-trips a token", () => {
    const token = "shpat_0123456789abcdef";
    expect(decryptToken(encryptToken(token))).toBe(token);
  });

  it("produces a fresh IV per call (same plaintext, different ciphertext)", () => {
    expect(encryptToken("same")).not.toBe(encryptToken("same"));
  });

  it("rejects a tampered ciphertext (auth tag)", () => {
    const payload = encryptToken("secret");
    const [iv, tag, data] = payload.split(":") as [string, string, string];
    const flipped = Buffer.from(data, "base64");
    flipped[0]! ^= 0xff;
    expect(() => decryptToken([iv, tag, flipped.toString("base64")].join(":"))).toThrow();
  });

  it("rejects a malformed payload", () => {
    expect(() => decryptToken("not-a-payload")).toThrow(/Malformed/);
  });

  it("fails loudly on a wrong-size key", () => {
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.from("short").toString("base64");
    try {
      expect(() => encryptToken("x")).toThrow(/32 bytes/);
    } finally {
      process.env.TOKEN_ENCRYPTION_KEY = KEY;
    }
  });
});
