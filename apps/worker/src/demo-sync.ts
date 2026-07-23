import type { Job } from "bullmq";
import type { Redis } from "ioredis";
import { publishEvent } from "@wezesha/realtime";
import type { SyncJobData } from "@wezesha/queue";

/**
 * Demo sync job: proves the pipeline end to end (queue → worker → Redis
 * pub/sub → gateway → socket) by publishing three progress phases and a done
 * event. Kept for smoke tests; real sources get their own processors (the
 * entrypoint dispatches on job.data.source).
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
