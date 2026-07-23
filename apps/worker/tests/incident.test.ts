import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import type { EmailMessage } from "../src/email";

/**
 * Once-per-incident semantics against real Redis + the real local database:
 * healthy→failed sends exactly one email, repeat failures stay silent, and
 * recovery re-arms the latch. Skips without local infrastructure.
 */

const redisUrl = process.env.REDIS_URL;
const localDb = /localhost|127\.0\.0\.1/.test(process.env.SERVICE_DATABASE_URL ?? "");
const runnable = Boolean(redisUrl) && localDb;

const SLUGS = {
  configured: "incident-test-configured",
  ownerOnly: "incident-test-owner-only",
  bare: "incident-test-bare",
};
const OWNER_EMAIL = "incident-owner@example.test";
const ALERT_EMAIL = "incident-alerts@example.test";

describe.skipIf(!runnable)("incident alerts (real redis + db)", () => {
  let prismaService: typeof import("@wezesha/db").prismaService;
  let incident: typeof import("../src/incident");
  let redis: Redis;
  let configuredId: string;
  let ownerOnlyId: string;
  let bareId: string;

  const collect = () => {
    const sent: EmailMessage[] = [];
    const send = async (message: EmailMessage) => {
      sent.push(message);
    };
    return { sent, send };
  };

  beforeAll(async () => {
    ({ prismaService } = await import("@wezesha/db"));
    incident = await import("../src/incident");
    redis = new Redis(redisUrl!);

    await prismaService.tenant.deleteMany({ where: { slug: { in: Object.values(SLUGS) } } });
    await prismaService.user.deleteMany({ where: { email: OWNER_EMAIL } });

    const configured = await prismaService.tenant.create({
      data: {
        name: "Incident Configured",
        slug: SLUGS.configured,
        tenantConfig: { create: { alertEmail: ALERT_EMAIL } },
      },
    });
    configuredId = configured.id;

    const user = await prismaService.user.create({
      data: { id: "incident-test-owner", name: "Incident Owner", email: OWNER_EMAIL },
    });
    const ownerOnly = await prismaService.tenant.create({
      data: {
        name: "Incident Owner Only",
        slug: SLUGS.ownerOnly,
        memberships: { create: { userId: user.id, role: "OWNER" } },
      },
    });
    ownerOnlyId = ownerOnly.id;

    const bare = await prismaService.tenant.create({
      data: { name: "Incident Bare", slug: SLUGS.bare },
    });
    bareId = bare.id;
  });

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: { in: Object.values(SLUGS) } } });
    await prismaService.user.deleteMany({ where: { email: OWNER_EMAIL } });
    await prismaService.$disconnect();
    await redis.quit();
  });

  it("latch opens once until cleared", async () => {
    await incident.clearIncident(redis, configuredId, "latch-probe");
    expect(await incident.openIncident(redis, configuredId, "latch-probe")).toBe(true);
    expect(await incident.openIncident(redis, configuredId, "latch-probe")).toBe(false);
    await incident.clearIncident(redis, configuredId, "latch-probe");
    expect(await incident.openIncident(redis, configuredId, "latch-probe")).toBe(true);
    await incident.clearIncident(redis, configuredId, "latch-probe");
  });

  it("routes to alertEmail, then falls back to the owner, then to nobody", async () => {
    await expect(incident.alertRecipient(configuredId)).resolves.toEqual({
      email: ALERT_EMAIL,
      tenantName: "Incident Configured",
    });
    await expect(incident.alertRecipient(ownerOnlyId)).resolves.toEqual({
      email: OWNER_EMAIL,
      tenantName: "Incident Owner Only",
    });
    await expect(incident.alertRecipient(bareId)).resolves.toBeNull();
    await expect(incident.alertRecipient("no-such-tenant")).resolves.toBeNull();
  });

  it("healthy→failed emails exactly once; repeats stay silent; recovery re-arms", async () => {
    const { sent, send } = collect();
    const alert = () =>
      incident.sendIncidentAlert({
        redis,
        tenantId: configuredId,
        source: "shopify",
        reason: "token revoked",
        send,
      });

    await expect(alert()).resolves.toBe(true);
    await expect(alert()).resolves.toBe(false);
    await expect(alert()).resolves.toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(ALERT_EMAIL);
    expect(sent[0]!.subject).toContain("Incident Configured");
    expect(sent[0]!.text).toContain("token revoked");

    // Recovery (a successful sync) clears the latch — the next incident mails again.
    await incident.clearIncident(redis, configuredId, "shopify");
    await expect(alert()).resolves.toBe(true);
    expect(sent).toHaveLength(2);
    await incident.clearIncident(redis, configuredId, "shopify");
  });

  it("releases the latch when there is no recipient", async () => {
    const { sent, send } = collect();
    await expect(
      incident.sendIncidentAlert({ redis, tenantId: bareId, source: "shopify", reason: "x", send })
    ).resolves.toBe(false);
    expect(sent).toHaveLength(0);
    // Latch was released — a later failure (recipient configured by then) can send.
    expect(await incident.openIncident(redis, bareId, "shopify")).toBe(true);
    await incident.clearIncident(redis, bareId, "shopify");
  });

  it("releases the latch when the send itself fails", async () => {
    const failingSend = async () => {
      throw new Error("smtp down");
    };
    await expect(
      incident.sendIncidentAlert({
        redis,
        tenantId: configuredId,
        source: "shopify",
        reason: "x",
        send: failingSend,
      })
    ).rejects.toThrow("smtp down");

    const { sent, send } = collect();
    await expect(
      incident.sendIncidentAlert({
        redis,
        tenantId: configuredId,
        source: "shopify",
        reason: "x",
        send,
      })
    ).resolves.toBe(true);
    expect(sent).toHaveLength(1);
    await incident.clearIncident(redis, configuredId, "shopify");
  });
});
