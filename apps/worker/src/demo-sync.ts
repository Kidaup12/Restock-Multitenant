import { Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { publishEvent } from "@wezesha/realtime";
import { SYNC_QUEUE, type SyncJobData } from "./queue";

/**
 * Demo sync job: proves the pipeline end to end (queue → worker → Redis
 * pub/sub → gateway → socket) by publishing three progress phases and a done
 * event. Real source syncs replace the loop body, not the wiring.
 */

const PHASES = ["fetch", "transform", "load"] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createDemoSyncProcessor(publisher: Redis, phaseDelayMs = 150) {
  return async (job: Job<SyncJobData>): Promise<void> => {
    const { tenantId, source } = job.data;
    for (let i = 0; i < PHASES.length; i++) {
      await publishEvent(publisher, {
        type: "sync.progress",
        data: { tenantId, source, phase: PHASES[i]!, done: i + 1, total: PHASES.length },
      });
      await sleep(phaseDelayMs);
    }
    await publishEvent(publisher, { type: "sync.done", data: { tenantId, source, ok: true } });
  };
}

export interface SyncWorkerOptions {
  /** BullMQ worker connection — must have maxRetriesPerRequest: null. */
  connection: Redis;
  /** Plain connection for publishing realtime events. */
  publisher: Redis;
  phaseDelayMs?: number;
}

export function createSyncWorker(options: SyncWorkerOptions): Worker<SyncJobData> {
  return new Worker<SyncJobData>(
    SYNC_QUEUE,
    createDemoSyncProcessor(options.publisher, options.phaseDelayMs),
    { connection: options.connection }
  );
}
