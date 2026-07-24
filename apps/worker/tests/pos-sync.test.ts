import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import type { Job } from "bullmq";
import type { SyncJobData } from "@wezesha/queue";
import { decodeEnvelope } from "@wezesha/realtime";
import type { PosSaleInput } from "@wezesha/pos";

/**
 * The POS sync processor against the real local database and Redis, with the
 * feed faked at the injection seam. Proves the worker path writes the same rows
 * the POST-payload path does, publishes pos.ingested + sync.done, and no-ops for
 * a tenant with no configured feed. Skips without local infrastructure.
 */

const redisUrl = process.env.REDIS_URL;
const localDb = /localhost|127\.0\.0\.1/.test(process.env.SERVICE_DATABASE_URL ?? "");
const runnable = Boolean(redisUrl) && localDb;

const SLUG = "pos-sync-test";
const UNCONFIGURED_SLUG = "pos-sync-test-noconf";

const feed: PosSaleInput[] = [
  {
    externalId: "PS1",
    date: "2026-07-15 10:00:00",
    warehouse: "Kilimani",
    createdBy: "Grace",
    lines: [
      { sku: "CAN-SHE-340", qty: 2, subtotal: 3300 },
      { sku: "UNKNOWN-1", qty: 1, subtotal: 50 },
    ],
  },
];

function jobStub(tenantId: string): Job<SyncJobData> {
  return {
    data: { tenantId, source: "pos" },
    opts: { attempts: 6 },
    attemptsMade: 1,
  } as unknown as Job<SyncJobData>;
}

async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!pred() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 25));
}

describe.skipIf(!runnable)("pos sync processor (real db + redis)", () => {
  let prismaService: typeof import("@wezesha/db").prismaService;
  let mod: typeof import("../src/pos-sync");
  let publisher: Redis;
  let subscriber: Redis;
  let tenantId: string;
  let unconfiguredTenantId: string;
  const received: string[] = [];

  beforeAll(async () => {
    ({ prismaService } = await import("@wezesha/db"));
    mod = await import("../src/pos-sync");
    publisher = new Redis(redisUrl!);

    await prismaService.tenant.deleteMany({ where: { slug: { in: [SLUG, UNCONFIGURED_SLUG] } } });
    const tenant = await prismaService.tenant.create({
      data: { name: "POS Sync Test", slug: SLUG, timezone: "Africa/Nairobi" },
    });
    tenantId = tenant.id;
    await prismaService.product.create({
      data: { tenantId, sku: "CAN-SHE-340", title: "Cantu Shea Butter Leave-In 340g", priceKes: 1650 },
    });
    await prismaService.tenantConfig.create({
      data: { tenantId, posFeedUrl: "https://feed.example/pos" },
    });

    const other = await prismaService.tenant.create({
      data: { name: "No POS Feed", slug: UNCONFIGURED_SLUG, timezone: "Africa/Nairobi" },
    });
    unconfiguredTenantId = other.id;

    subscriber = new Redis(redisUrl!);
    await subscriber.subscribe(`tenant:${tenantId}`, `tenant:${unconfiguredTenantId}`);
    subscriber.on("message", (_ch, msg) => received.push(msg));
  });

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: { in: [SLUG, UNCONFIGURED_SLUG] } } });
    await prismaService.$disconnect();
    await subscriber.quit();
    await publisher.quit();
  });

  it("pulls the feed, ingests, and publishes pos.ingested + sync.done", async () => {
    received.length = 0;
    const processor = mod.createPosSyncProcessor({ publisher, loadFeed: async () => feed });
    await processor(jobStub(tenantId));

    const sales = await prismaService.posSale.count({ where: { tenantId } });
    expect(sales).toBe(1);
    const sh = await prismaService.salesHistory.findMany({ where: { tenantId, channel: "pos" } });
    expect(sh).toHaveLength(1);
    expect(sh[0]!.quantity).toBe(2);
    expect(sh[0]!.revenueKes).toBe(3300);

    await waitFor(() => received.length >= 2);
    const events = received.map((m) => decodeEnvelope(m)).filter(Boolean);
    const ingested = events.find((e) => e!.type === "pos.ingested");
    expect(ingested?.data).toMatchObject({ tenantId, salesIngested: 1, linesUnmatched: 1 });
    expect(events.some((e) => e!.type === "sync.done" && (e!.data as { ok: boolean }).ok)).toBe(true);
  });

  it("no-ops (no fetch) for a tenant with no configured feed", async () => {
    received.length = 0;
    let fetched = false;
    const processor = mod.createPosSyncProcessor({
      publisher,
      loadFeed: async () => {
        fetched = true;
        return [];
      },
    });
    await processor(jobStub(unconfiguredTenantId));
    expect(fetched).toBe(false);
    expect(await prismaService.posSale.count({ where: { tenantId: unconfiguredTenantId } })).toBe(0);

    await waitFor(() => received.length >= 1);
    const events = received.map((m) => decodeEnvelope(m)).filter(Boolean);
    expect(events.some((e) => e!.type === "sync.done")).toBe(true);
  });

  it("raises a bell notification on a final failure", async () => {
    await prismaService.notification.deleteMany({ where: { tenantId, kind: "pos_sync_failed" } });
    const job = { data: { tenantId, source: "pos" }, opts: { attempts: 6 }, attemptsMade: 6 } as unknown as Job<SyncJobData>;
    await mod.handlePosSyncFailure(job, new Error("feed 503"), publisher);
    const notes = await prismaService.notification.findMany({ where: { tenantId, kind: "pos_sync_failed" } });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toContain("feed 503");
  });

  it("stays silent on a retry-pending failure", async () => {
    await prismaService.notification.deleteMany({ where: { tenantId, kind: "pos_sync_failed" } });
    const job = { data: { tenantId, source: "pos" }, opts: { attempts: 6 }, attemptsMade: 2 } as unknown as Job<SyncJobData>;
    await mod.handlePosSyncFailure(job, new Error("transient"), publisher);
    expect(await prismaService.notification.count({ where: { tenantId, kind: "pos_sync_failed" } })).toBe(0);
  });
});
