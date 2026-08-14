import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import type { Job } from "bullmq";
import type { SyncJobData } from "@wezesha/queue";
import type { EmailMessage } from "../src/email";

/**
 * Final-failure alerting for POS pulls, against the real local database and
 * Redis with the email seam injected. The POS feed is pulled on the same tick as
 * Shopify, so a broken feed fails over and over: the bell must carry one entry
 * per window rather than one per tick, and the tenant's alert contact must hear
 * about it once per incident. Skips without local infrastructure.
 */

const redisUrl = process.env.REDIS_URL;
const localDb = /localhost|127\.0\.0\.1/.test(process.env.SERVICE_DATABASE_URL ?? "");
const runnable = Boolean(redisUrl) && localDb;

const SLUG = "pos-alerts-test";
const ALERT_EMAIL = "pos-alerts@example.test";

function finalFailureJob(tenantId: string): Job<SyncJobData> {
  return {
    data: { tenantId, source: "pos" },
    opts: { attempts: 6 },
    attemptsMade: 6,
  } as unknown as Job<SyncJobData>;
}

describe.skipIf(!runnable)("pos final-failure alerts (real db + redis)", () => {
  let prismaService: typeof import("@wezesha/db").prismaService;
  let mod: typeof import("../src/pos-sync");
  let clearIncident: typeof import("../src/incident").clearIncident;
  let dedupMs: number;
  let publisher: Redis;
  let tenantId: string;

  const collect = () => {
    const sent: EmailMessage[] = [];
    const send = async (message: EmailMessage) => {
      sent.push(message);
    };
    return { sent, send };
  };

  const notices = () =>
    prismaService.notification.findMany({
      where: { tenantId, kind: "pos_sync_failed" },
      orderBy: { createdAt: "asc" },
    });

  beforeAll(async () => {
    process.env.TOKEN_ENCRYPTION_KEY ??= crypto.randomBytes(32).toString("base64");
    ({ prismaService } = await import("@wezesha/db"));
    mod = await import("../src/pos-sync");
    ({ clearIncident } = await import("../src/incident"));
    ({ SYNC_FAILURE_NOTICE_DEDUP_MS: dedupMs } = await import("../src/shopify-sync"));
    publisher = new Redis(redisUrl!);

    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    const tenant = await prismaService.tenant.create({
      data: {
        name: "POS Alerts Test",
        slug: SLUG,
        timezone: "Africa/Nairobi",
        tenantConfig: { create: { alertEmail: ALERT_EMAIL, posFeedUrl: "https://feed.example/pos" } },
      },
    });
    tenantId = tenant.id;
  });

  afterAll(async () => {
    await clearIncident(publisher, tenantId, "pos");
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    await prismaService.$disconnect();
    await publisher.quit();
  });

  beforeEach(async () => {
    await prismaService.notification.deleteMany({ where: { tenantId, kind: "pos_sync_failed" } });
    await clearIncident(publisher, tenantId, "pos");
  });

  it("raises one bell entry and one alert email, not one per failed tick", async () => {
    const { sent, send } = collect();
    const fail = () => mod.handlePosSyncFailure(finalFailureJob(tenantId), new Error("feed 503"), publisher, { send });

    await fail();
    await fail();

    const raised = await notices();
    // One, not two (spam) and not zero (over-suppression — the shop would never
    // learn the feed is down).
    expect(raised).toHaveLength(1);
    expect(raised[0]!.body).toContain("feed 503");

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(ALERT_EMAIL);
    expect(sent[0]!.subject).toContain("POS Alerts Test");
    expect(sent[0]!.text).toContain("feed 503");
  });

  it("re-raises the bell once the window has elapsed", async () => {
    const { send } = collect();
    const fail = () => mod.handlePosSyncFailure(finalFailureJob(tenantId), new Error("feed 503"), publisher, { send });

    await fail();
    await fail();
    expect(await notices()).toHaveLength(1);

    // Age the entry past the window: a still-broken feed is worth saying again
    // twice a day. Without this the dedup would be indistinguishable from
    // suppressing the notice outright.
    await prismaService.notification.updateMany({
      where: { tenantId, kind: "pos_sync_failed" },
      data: { createdAt: new Date(Date.now() - dedupMs - 60_000) },
    });
    await fail();

    expect(await notices()).toHaveLength(2);
  });

  it("a recovered pull re-arms the alert, so the next incident mails again", async () => {
    const { sent, send } = collect();
    const fail = () => mod.handlePosSyncFailure(finalFailureJob(tenantId), new Error("feed 503"), publisher, { send });

    await fail();
    await fail();
    expect(sent).toHaveLength(1);

    // A pull that works again is the recovery signal; the latch has to release
    // or the tenant hears about the first incident and no other, ever.
    const processor = mod.createPosSyncProcessor({ publisher, loadFeed: async () => [] });
    await processor(finalFailureJob(tenantId));

    await fail();
    expect(sent).toHaveLength(2);
  });

  it("stays silent on a retry-pending failure", async () => {
    const { sent, send } = collect();
    const job = {
      data: { tenantId, source: "pos" },
      opts: { attempts: 6 },
      attemptsMade: 2,
    } as unknown as Job<SyncJobData>;

    await mod.handlePosSyncFailure(job, new Error("transient"), publisher, { send });

    expect(await notices()).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });
});
