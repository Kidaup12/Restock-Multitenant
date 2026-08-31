import crypto from "node:crypto";

/**
 * Authenticated encryption for OAuth tokens at rest.
 *
 * AES-256-GCM with a single app key from TOKEN_ENCRYPTION_KEY (32 bytes,
 * base64). Each ciphertext is self-describing:
 * `base64(iv):base64(authTag):base64(ciphertext)`. GCM is authenticated — a
 * tampered ciphertext fails decrypt() (the auth tag won't verify), so a
 * corrupted/forged token throws rather than silently decrypting.
 *
 * Server-side only (web route handlers + worker). The key is read lazily inside
 * the functions so the module imports cleanly before env is set and tests can
 * set the key in beforeAll.
 */

function getKey(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("TOKEN_ENCRYPTION_KEY is not set (need 32 bytes, base64).");
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must decode to 32 bytes for AES-256, got ${key.length}. Generate: openssl rand -base64 32`
    );
  }
  return key;
}

/** Encrypt a UTF-8 string → `iv:authTag:ciphertext` (all base64). Random IV per call. */
export function encryptToken(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12); // 96-bit IV, the GCM standard
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map((b) => b.toString("base64")).join(":");
}

/** Decrypt an `iv:authTag:ciphertext` payload. Throws if the auth tag fails (tamper). */
export function decryptToken(payload: string): string {
  const key = getKey();
  const parts = payload.split(":");
  if (parts.length !== 3) {
    throw new Error("Malformed ciphertext payload (expected iv:authTag:ciphertext).");
  }
  const [iv, authTag, ciphertext] = parts.map((p) => Buffer.from(p, "base64"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv as Buffer);
  decipher.setAuthTag(authTag as Buffer);
  return Buffer.concat([decipher.update(ciphertext as Buffer), decipher.final()]).toString("utf8");
}
