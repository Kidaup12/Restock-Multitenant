import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import type { Queue } from "bullmq";
import { encryptToken } from "@wezesha/shopify";
import { createSyncQueue, syncJobId, type SyncQueue } from "@wezesha/queue";

/**
 * The recurring Shopify sync. What matters here is not that a job runs, but
 * WHICH shops it asks for and what it refuses to ask twice: a tick must reach
 * every connected shop, skip the disconnected and the uninstalled, and be a
 * no-op for a shop whose previous sync has not finished.
 */

const redisUrl = process.env.REDIS_URL;
const localDb = /localhost|127\.0\.0\.1/.test(process.env.SERVICE_DATABASE_URL ?? "");
const runnable = Boolean(redisUrl) && localDb;

const CONNECTED = "sync-sched-connected";
const UNINSTALLED = "sync-sched-uninstalled";
const NO_CONNECTION = "sync-sched-unconnected";
const PAUSED = "sync-sched-paused";
const SLUGS = [CONNECTED, UNINSTALLED, NO_CONNECTION, PAUSED];

describe.skipIf(!runnable)("shopify sync schedule (real redis + db)", () => {
  let prismaService: typeof import("@wezesha/db").prismaService;
  let cron: typeof import("../src/sync-schedule-cron");
  let connection: Redis;
  let queue: Queue;
  let syncQueue: SyncQueue;
  let connectedId: string;
  let uninstalledId: string;
  let pausedId: string;

  beforeAll(async () => {
    process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
    ({ prismaService } = await import("@wezesha/db"));
    cron = await import("../src/sync-schedule-cron");

    connection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    queue = cron.createSyncScheduleQueue(connection);
    syncQueue = createSyncQueue(connection);
    await queue.obliterate({ force: true });

    await prismaService.tenant.deleteMany({ where: { slug: { in: SLUGS } } });

    const live = await prismaService.tenant.create({
      data: { name: "Sync Sched Connected", slug: CONNECTED },
    });
    connectedId = live.id;
    await prismaService.shopifyConnection.create({
      data: {
        tenantId: connectedId,
        shopDomain: "sync-sched-live.myshopify.com",
        accessToken: encryptToken("shpat_sched_live"),
        scopes: "read_products",
      },
    });

    // Uninstalled the app: still has a connection row, must never be synced.
    const gone = await prismaService.tenant.create({
      data: { name: "Sync Sched Uninstalled", slug: UNINSTALLED },
    });
    uninstalledId = gone.id;
    await prismaService.shopifyConnection.create({
      data: {
        tenantId: uninstalledId,
        shopDomain: "sync-sched-gone.myshopify.com",
        accessToken: encryptToken("shpat_sched_gone"),
        scopes: "read_products",
        uninstalledAt: new Date(),
      },
    });

    // Never connected at all.
    await prismaService.tenant.create({
      data: { name: "Sync Sched Unconnected", slug: NO_CONNECTION },
    });

    // Token revoked and given up on: still installed, but retrying it four times
    // an hour is what filled a live shop's bell with hundreds of identical rows.
    const stuck = await prismaService.tenant.create({
      data: { name: "Sync Sched Paused", slug: PAUSED },
    });
    pausedId = stuck.id;
    await prismaService.shopifyConnection.create({
      data: {
        tenantId: pausedId,
        shopDomain: "sync-sched-paused.myshopify.com",
        accessToken: encryptToken("shpat_sched_paused"),
        scopes: "read_products",
        authFailureCount: 3,
        syncPausedAt: new Date(),
      },
    });
  }, 30_000);

  beforeEach(async () => {
    await syncQueue.obliterate({ force: true });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await syncQueue.obliterate({ force: true });
    await queue.close();
    await syncQueue.close();
    await prismaService.tenant.deleteMany({ where: { slug: { in: SLUGS } } });
    await prismaService.$disconnect();
    await connection.quit();
  });

  it("registers both schedules idempotently, at the configured cadence", async () => {
    await cron.registerSyncSchedules(queue);
    await cron.registerSyncSchedules(queue);

    const schedulers = await queue.getJobSchedulers();
    const tick = schedulers.filter((s) => s.key === cron.SHOPIFY_SYNC_SCHEDULER);
    const full = schedulers.filter((s) => s.key === cron.SHOPIFY_FULL_SYNC_SCHEDULER);
    expect(tick).toHaveLength(1);
    expect(full).toHaveLength(1);
    expect(tick[0]!.pattern).toBe(cron.shopifySyncPattern());
    expect(full[0]!.pattern).toBe(cron.FULL_SYNC_PATTERN);

    await queue.removeJobScheduler(cron.SHOPIFY_SYNC_SCHEDULER);
    await queue.removeJobScheduler(cron.SHOPIFY_FULL_SYNC_SCHEDULER);
  });

  it("defaults to every 15 minutes and honours an override", () => {
    const original = process.env.SHOPIFY_SYNC_PATTERN;
    try {
      delete process.env.SHOPIFY_SYNC_PATTERN;
      expect(cron.shopifySyncPattern()).toBe("*/15 * * * *");
      process.env.SHOPIFY_SYNC_PATTERN = "*/30 * * * *";
      expect(cron.shopifySyncPattern()).toBe("*/30 * * * *");
      // An empty value is a mis-set variable, not a request for no schedule.
      process.env.SHOPIFY_SYNC_PATTERN = "   ";
      expect(cron.shopifySyncPattern()).toBe("*/15 * * * *");
    } finally {
      if (original === undefined) delete process.env.SHOPIFY_SYNC_PATTERN;
      else process.env.SHOPIFY_SYNC_PATTERN = original;
    }
  });

  it("asks for a sync for connected shops only", async () => {
    const result = await cron.dispatchShopifySyncs(syncQueue);
    expect(result.enqueued).toBeGreaterThan(0);
    expect(result.considered).toBe(result.enqueued);

    const queued = await syncQueue.getJobs(["waiting", "prioritized", "active", "delayed"]);
    const tenantIds = queued.map((j) => j.data.tenantId);
    expect(tenantIds).toContain(connectedId);
    // The uninstalled shop has a connection row; syncing it would burn retries
    // against an app the merchant has removed.
    expect(tenantIds).not.toContain(uninstalledId);
    // Same for a store whose token keeps being refused: only a reconnect or a
    // deliberate "Sync now" gets it moving again, and neither arrives via a tick.
    expect(tenantIds).not.toContain(pausedId);
  });

  it("leaves a paused shop's cursor alone on the nightly full sync", async () => {
    // markTenantsForFullSync shares connectedTenantIds, so a paused store must
    // not have its products cursor dropped — it would re-pull the whole
    // catalogue the moment someone reconnects, for no reason.
    await prismaService.ingestCursor.deleteMany({ where: { tenantId: pausedId } });
    await prismaService.ingestCursor.create({
      data: { tenantId: pausedId, source: "shopify", resource: "products", cursor: new Date() },
    });

    await cron.markTenantsForFullSync();

    const left = await prismaService.ingestCursor.findMany({
      where: { tenantId: pausedId, source: "shopify" },
      select: { resource: true },
    });
    expect(left.map((r) => r.resource)).toEqual(["products"]);
  });

  it("is a no-op for a shop whose sync has not finished", async () => {
    await cron.dispatchShopifySyncs(syncQueue);
    const first = await syncQueue.getJob(syncJobId({ tenantId: connectedId, source: "shopify" }));
    expect(first).toBeTruthy();

    // The next tick arrives while that job is still queued — the whole reason a
    // 15-minute cadence is safe for a shop whose catalogue takes longer.
    const second = await cron.dispatchShopifySyncs(syncQueue);
    expect(second.alreadyRunning).toBeGreaterThan(0);

    const queued = await syncQueue.getJobs(["waiting", "prioritized", "active", "delayed"]);
    expect(queued.filter((j) => j.data.tenantId === connectedId)).toHaveLength(1);
  });

  it("clears the products cursor daily so removed products can be noticed", async () => {
    // The sweep that stamps missingFromShopifyAt only runs on a full pull, and a
    // cursor exists after the first sync forever — so without this, a product
    // deleted in Shopify stays in the catalogue indefinitely.
    await prismaService.ingestCursor.create({
      data: { tenantId: connectedId, source: "shopify", resource: "products", cursor: new Date() },
    });
    await prismaService.ingestCursor.create({
      data: { tenantId: connectedId, source: "shopify", resource: "orders", cursor: new Date() },
    });

    const cleared = await cron.markTenantsForFullSync();
    expect(cleared).toBeGreaterThan(0);

    const remaining = await prismaService.ingestCursor.findMany({
      where: { tenantId: connectedId, source: "shopify" },
      select: { resource: true },
    });
    // Only the products cursor goes: re-pulling a year of orders every night
    // would be an expensive way to answer a question about the catalogue.
    expect(remaining.map((r) => r.resource)).toEqual(["orders"]);
  });

  it("prunes finished sync runs past the window but never a running one", async () => {
    const old = new Date(Date.now() - (cron.SYNC_RUN_RETENTION_DAYS + 2) * 86_400_000);
    await prismaService.syncRun.create({
      data: { tenantId: connectedId, source: "shopify", status: "ok", startedAt: old, finishedAt: old },
    });
    await prismaService.syncRun.create({
      data: { tenantId: connectedId, source: "shopify", status: "ok", startedAt: new Date(), finishedAt: new Date() },
    });
    // A run this old that never finished is a stuck sync — evidence, not litter.
    await prismaService.syncRun.create({
      data: { tenantId: connectedId, source: "shopify", status: "running", startedAt: old },
    });

    await cron.pruneSyncRuns();

    const left = await prismaService.syncRun.findMany({
      where: { tenantId: connectedId },
      select: { status: true, finishedAt: true },
    });
    expect(left).toHaveLength(2);
    expect(left.filter((r) => r.status === "running")).toHaveLength(1);
    expect(left.every((r) => r.finishedAt === null || r.finishedAt > old)).toBe(true);
  });

  it("closes a run the worker was killed inside, and spares one still working", async () => {
    // Ten of these had built up in production: the processor closes its row on
    // success and on failure, so a row still "running" an hour later means the
    // process died mid-flight — a redeploy. Left alone they accumulate forever
    // and read as "syncing now".
    await prismaService.syncRun.deleteMany({ where: { tenantId: connectedId } });
    const now = new Date();
    const abandoned = await prismaService.syncRun.create({
      data: {
        tenantId: connectedId,
        source: "shopify",
        status: "running",
        startedAt: new Date(now.getTime() - 3 * 3_600_000),
      },
    });
    // The boundary case that stops this eating live work: a sync takes about
    // three minutes, so one that started a minute ago is genuinely in flight.
    const inFlight = await prismaService.syncRun.create({
      data: {
        tenantId: connectedId,
        source: "shopify",
        status: "running",
        startedAt: new Date(now.getTime() - 60_000),
      },
    });

    expect(await cron.reapStrandedRuns(now)).toBe(1);

    const closed = await prismaService.syncRun.findUniqueOrThrow({ where: { id: abandoned.id } });
    expect(closed.status).toBe("failed");
    expect(closed.finishedAt).not.toBeNull();
    // The row stays as evidence and says what happened — deleting it would take
    // the Connections screen's only record of a run that did not finish.
    expect(closed.error).toContain("Interrupted");

    const untouched = await prismaService.syncRun.findUniqueOrThrow({ where: { id: inFlight.id } });
    expect(untouched.status).toBe("running");
  });
});
