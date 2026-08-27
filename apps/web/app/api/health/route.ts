import { NextResponse } from "next/server";
import { Redis } from "ioredis";
import { prismaService } from "@wezesha/db";
import { WORKER_HEARTBEAT_KEY } from "@wezesha/observability";
import { intakeConfigured, intakeLive } from "@/lib/worker-intake";

/**
 * Uptime probe for external pingers (see deploy/RUNBOOK.md, Uptime
 * monitoring). Unauthenticated by design — it returns health booleans, never
 * data. 200 = web up + database answering; 503 = database check failed.
 * `worker` reports the worker's Redis heartbeat so one HTTP monitor can watch
 * a service with no port: true = beating, false = key absent (worker down),
 * null = Redis unreachable/unconfigured (says nothing about the worker).
 */

export const dynamic = "force-dynamic";

const DB_TIMEOUT_MS = 1_000;
const REDIS_TIMEOUT_MS = 500;

// Own connection, kept across dev reloads (same pattern as lib/shopify/queue).
// Lazy + short timeouts: a down Redis costs this route half a second, not a hang.
const globalForHealth = globalThis as unknown as { wezeshaHealthRedis?: Redis };

function getHealthRedis(): Redis | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  if (!globalForHealth.wezeshaHealthRedis) {
    globalForHealth.wezeshaHealthRedis = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: REDIS_TIMEOUT_MS,
      enableOfflineQueue: false,
    });
    globalForHealth.wezeshaHealthRedis.on("error", () => {});
  }
  return globalForHealth.wezeshaHealthRedis;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

export async function GET(): Promise<NextResponse> {
  const db =
    (await withTimeout(
      prismaService.$queryRaw`SELECT 1`.then(() => true),
      DB_TIMEOUT_MS
    )) === true;

  let worker: boolean | null = null;
  if (intakeConfigured()) {
    // Hosted apart from the worker: ask it directly. Answering proves the
    // process is up AND its event loop is turning, which is what the heartbeat
    // was standing in for when there was no port to talk to.
    worker = await intakeLive();
    return NextResponse.json({ ok: db, db, worker }, { status: db ? 200 : 503 });
  }
  const redis = getHealthRedis();
  if (redis) {
    // Wrap the value so "key absent" (worker down) stays distinguishable from
    // "Redis didn't answer" (null — says nothing about the worker).
    const beat = await withTimeout(
      redis.get(WORKER_HEARTBEAT_KEY).then((value) => ({ value })),
      REDIS_TIMEOUT_MS
    );
    worker = beat === null ? null : beat.value !== null;
  }

  return NextResponse.json({ ok: db, db, worker }, { status: db ? 200 : 503 });
}
