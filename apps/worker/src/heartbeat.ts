import type { Redis } from "ioredis";
import {
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_KEY,
  WORKER_HEARTBEAT_TTL_SECONDS,
} from "@wezesha/observability";

/**
 * Liveness beacon for a service that listens on nothing: refresh a Redis key
 * with a TTL, so "worker down" becomes "key absent" — readable by the web
 * health endpoint (which an external pinger watches). A hung event loop stops
 * the beats just like a dead process, which is the point.
 */

export interface HeartbeatOptions {
  key?: string;
  ttlSeconds?: number;
  intervalMs?: number;
}

/** Start beating. Returns a stop function (also safe to skip — the timer is
 *  unref'd, so it never holds the process open). */
export function startHeartbeat(redis: Redis, options: HeartbeatOptions = {}): () => void {
  const {
    key = WORKER_HEARTBEAT_KEY,
    ttlSeconds = WORKER_HEARTBEAT_TTL_SECONDS,
    intervalMs = WORKER_HEARTBEAT_INTERVAL_MS,
  } = options;

  const beat = () => {
    redis
      .set(key, new Date().toISOString(), "EX", ttlSeconds)
      .catch((err) => console.error("worker: heartbeat write failed", err));
  };
  beat();
  const timer = setInterval(beat, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
