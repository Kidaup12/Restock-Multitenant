/**
 * Uptime contract shared across services. The worker refreshes a Redis key on
 * an interval; the web health endpoint reports whether the key is present, so
 * one external HTTP pinger can watch a service that listens on nothing.
 * Constants live here because worker (writer) and web (reader) must agree.
 */

export const WORKER_HEARTBEAT_KEY = "ops:worker:heartbeat";

/** Key TTL — three missed 30s beats before the key expires and alarms. */
export const WORKER_HEARTBEAT_TTL_SECONDS = 90;

/** Beat cadence. */
export const WORKER_HEARTBEAT_INTERVAL_MS = 30_000;
