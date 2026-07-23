import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { SYNC_QUEUE, createSyncQueue, enqueueSyncOnce, syncJobId, type SyncJobData, type SyncQueue } from "../src";

describe("syncJobId", () => {
  it("is deterministic per tenant+source", () => {
    expect(syncJobId({ tenantId: "t1", source: "shopify" })).toBe("sync:t1:shopify");
    expect(syncJobId({ tenantId: "t1", source: "shopify" })).toBe(
      syncJobId({ tenantId: "t1", source: "shopify" })
    );
    expect(syncJobId({ tenantId: "t2", source: "shopify" })).not.toBe(
      syncJobId({ tenantId: "t1", source: "shopify" })
    );
  });
});

// Real-Redis contract proof: one tenant+source can never hold two sync jobs.
// Run with REDIS_URL set (docker compose up -d redis → redis://localhost:6380).
const redisUrl = process.env.REDIS_URL;

describe.skipIf(!redisUrl)("enqueueSyncOnce (real Redis)", () => {
  let connection: Redis;
  let queue: SyncQueue;

  beforeAll(() => {
    connection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    queue = createSyncQueue(connection);
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
    await connection.quit();
  });

  const data: SyncJobData = { tenantId: "t-overlap", source: "shopify" };

  it("rejects a duplicate while the job is waiting", async () => {
    expect(await enqueueSyncOnce(queue, data)).toEqual({
      enqueued: true,
      jobId: "sync:t-overlap:shopify",
    });
    expect(await enqueueSyncOnce(queue, data)).toEqual({
      enqueued: false,
      jobId: "sync:t-overlap:shopify",
      state: "waiting",
    });
  });

  it("rejects a duplicate while the job is running, accepts after completion", async () => {
    let releaseJob!: () => void;
    const gate = new Promise<void>((r) => (releaseJob = r));
    let signalStarted!: () => void;
    const started = new Promise<void>((r) => (signalStarted = r));

    const workerConnection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const worker = new Worker<SyncJobData>(
      SYNC_QUEUE,
      async () => {
        signalStarted();
        await gate;
      },
      { connection: workerConnection }
    );
    const completed = new Promise<void>((r) => worker.on("completed", () => r()));

    try {
      expect((await enqueueSyncOnce(queue, data)).enqueued).toBe(true);
      await started;

      const duplicate = await enqueueSyncOnce(queue, data);
      expect(duplicate).toEqual({
        enqueued: false,
        jobId: "sync:t-overlap:shopify",
        state: "active",
      });

      releaseJob();
      await completed;

      // Finished job is removed, so the id frees up for the next run.
      expect((await enqueueSyncOnce(queue, data)).enqueued).toBe(true);
    } finally {
      releaseJob();
      await worker.close();
      await workerConnection.quit();
    }
  });

  it("does not block other tenants or sources", async () => {
    expect((await enqueueSyncOnce(queue, data)).enqueued).toBe(true);
    expect(
      (await enqueueSyncOnce(queue, { tenantId: "t-overlap", source: "quickbooks" })).enqueued
    ).toBe(true);
    expect(
      (await enqueueSyncOnce(queue, { tenantId: "t-other", source: "shopify" })).enqueued
    ).toBe(true);
  });
});
