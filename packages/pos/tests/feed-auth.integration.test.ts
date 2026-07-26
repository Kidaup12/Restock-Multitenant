import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { authenticatePosFeed, generatePosIngestSecret, hashPosIngestSecret } from "../src/auth";

/**
 * Feed authentication against a real database. The payload names the tenant, so
 * the credential is the whole boundary: these prove it is bound to ONE tenant,
 * that an unprovisioned tenant is closed rather than open, and that every
 * rejection looks the same from outside. FAILs (not skips) off a local DB — a
 * silent skip would hide an open door.
 */

const local = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "");

const SLUG_A = "pos-auth-a";
const SLUG_B = "pos-auth-b";
const FEED_SLUG_B = "till-b-nairobi"; // B is reached by its posFeedSlug, not its tenant slug
const SLUG_UNPROVISIONED = "pos-auth-none";

const secretA = generatePosIngestSecret();
const secretB = generatePosIngestSecret();

let tenantA: string;
let tenantB: string;
let tenantUnprovisioned: string;

async function makeTenant(slug: string, config?: { posFeedSlug?: string; hash?: string }) {
  await prismaService.tenant.deleteMany({ where: { slug } });
  const tenant = await prismaService.tenant.create({ data: { name: slug, slug } });
  if (config) {
    await prismaService.tenantConfig.create({
      data: {
        tenantId: tenant.id,
        posFeedSlug: config.posFeedSlug ?? null,
        posIngestSecretHash: config.hash ?? null,
      },
    });
  }
  return tenant.id;
}

beforeAll(async () => {
  expect(local, "pos feed auth integration must run against a local database").toBe(true);
  tenantA = await makeTenant(SLUG_A, { hash: hashPosIngestSecret(secretA) });
  tenantB = await makeTenant(SLUG_B, { posFeedSlug: FEED_SLUG_B, hash: hashPosIngestSecret(secretB) });
  tenantUnprovisioned = await makeTenant(SLUG_UNPROVISIONED, {});
});

afterAll(async () => {
  await prismaService.tenant.deleteMany({
    where: { slug: { in: [SLUG_A, SLUG_B, SLUG_UNPROVISIONED] } },
  });
  await prismaService.$disconnect();
});

describe("authenticatePosFeed", () => {
  it("opens the tenant its own secret belongs to", async () => {
    expect(await authenticatePosFeed(SLUG_A, secretA)).toEqual({ id: tenantA });
  });

  it("resolves a tenant by its configured posFeedSlug, still bound to that tenant's secret", async () => {
    expect(await authenticatePosFeed(FEED_SLUG_B, secretB)).toEqual({ id: tenantB });
  });

  it("refuses one tenant's secret for another tenant's slug, both ways round", async () => {
    expect(await authenticatePosFeed(FEED_SLUG_B, secretA)).toBeNull();
    expect(await authenticatePosFeed(SLUG_B, secretA)).toBeNull();
    expect(await authenticatePosFeed(SLUG_A, secretB)).toBeNull();
  });

  it("keeps a tenant with no secret provisioned closed", async () => {
    expect(tenantUnprovisioned).toBeTruthy();
    expect(await authenticatePosFeed(SLUG_UNPROVISIONED, secretA)).toBeNull();
    expect(await authenticatePosFeed(SLUG_UNPROVISIONED, generatePosIngestSecret())).toBeNull();
  });

  it("rejects a blank or whitespace secret", async () => {
    expect(await authenticatePosFeed(SLUG_A, "")).toBeNull();
    expect(await authenticatePosFeed(SLUG_A, "   ")).toBeNull();
  });

  it("rejects an unknown slug", async () => {
    expect(await authenticatePosFeed("no-such-slug", secretA)).toBeNull();
    expect(await authenticatePosFeed("", secretA)).toBeNull();
  });

  it("tolerates surrounding whitespace on an otherwise valid secret", async () => {
    expect(await authenticatePosFeed(SLUG_A, ` ${secretA} `)).toEqual({ id: tenantA });
  });

  it("rejects a stored hash of the wrong length instead of throwing", async () => {
    // A hand-edited / truncated hash column must close the door, not 500 the
    // endpoint — timingSafeEqual throws on mismatched buffer lengths.
    const short = await makeTenant("pos-auth-corrupt", { hash: "deadbeef" });
    expect(short).toBeTruthy();
    await expect(authenticatePosFeed("pos-auth-corrupt", secretA)).resolves.toBeNull();
    await expect(authenticatePosFeed("pos-auth-corrupt", "deadbeef")).resolves.toBeNull();
    await prismaService.tenant.deleteMany({ where: { slug: "pos-auth-corrupt" } });
  });
});

describe("ingest secret material", () => {
  it("hashes deterministically, to a sha256 hex digest, and never stores the plaintext", () => {
    const secret = generatePosIngestSecret();
    const hash = hashPosIngestSecret(secret);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPosIngestSecret(secret)).toBe(hash);
    expect(hash).not.toContain(secret);
    expect(hashPosIngestSecret(`${secret}x`)).not.toBe(hash);
  });

  it("generates unguessable, URL-safe secrets", () => {
    const secrets = new Set(Array.from({ length: 50 }, () => generatePosIngestSecret()));
    expect(secrets.size).toBe(50);
    for (const s of secrets) expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, base64url
  });
});
