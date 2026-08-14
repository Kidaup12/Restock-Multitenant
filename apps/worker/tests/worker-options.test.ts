import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Worker } from "bullmq";
import { Redis } from "ioredis";
import {
  SYNC_LOCK_DURATION_MS,
  SYNC_MAX_STALLED_COUNT,
  SYNC_STALLED_INTERVAL_MS,
  createSyncWorker,
} from "../src/worker";

/**
 * Crash-recovery settings are load-bearing, not cosmetic: BullMQ's defaults
 * decide when a sync job is declared stalled and re-delivered, and a
 * re-delivery while the original is still running means two writers on one
 * tenant. Assert the constructed worker actually carries the numbers the module
 * declares — a value that lives only in a comment protects nothing.
 */

const redisUrl = process.env.REDIS_URL;

describe.skipIf(!redisUrl)("sync worker crash-recovery options", () => {
  let connection: Redis;
  let publisher: Redis;
  let worker: Worker;

  beforeAll(() => {
    connection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    publisher = new Redis(redisUrl!);
    worker = createSyncWorker({ connection, publisher });
  });

  afterAll(async () => {
    await worker?.close();
    await Promise.all([connection?.quit(), publisher?.quit()]);
  });

  it("sets the declared lock duration", () => {
    expect(worker.opts.lockDuration).toBe(SYNC_LOCK_DURATION_MS);
  });

  it("sets the declared stalled-check interval", () => {
    expect(worker.opts.stalledInterval).toBe(SYNC_STALLED_INTERVAL_MS);
  });

  it("sets the declared stalled-recovery allowance", () => {
    expect(worker.opts.maxStalledCount).toBe(SYNC_MAX_STALLED_COUNT);
  });

  it("keeps the lock window wider than the stalled check", () => {
    // The check has to run — and find a live lock — several times inside one
    // lock window, or a healthy worker gets swept by its own scan.
    expect(SYNC_LOCK_DURATION_MS).toBeGreaterThan(
      SYNC_STALLED_INTERVAL_MS * 2
    );
  });
});
