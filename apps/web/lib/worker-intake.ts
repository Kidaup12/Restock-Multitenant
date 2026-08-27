import type { EnqueueResult, SyncJobData } from "@wezesha/queue";
import type { RealtimeEvent } from "@wezesha/realtime";

/**
 * Transport for work this app hands to the worker.
 *
 * Two valid deployments, chosen by whether WORKER_INTAKE_URL is set:
 *
 *  - unset  — web and worker share a private network, so the app talks to Redis
 *             directly (see lib/shopify/queue).
 *  - set    — web is hosted apart from the worker. The app posts over HTTPS
 *             instead, and Redis is never exposed to the internet. Reaching a
 *             private Redis from another host would mean a public endpoint whose
 *             AUTH password crosses the network in clear text.
 *
 * This is a transport choice, not a fallback: a URL with no secret is a
 * misconfiguration and throws rather than quietly reverting to Redis.
 */

const TIMEOUT_MS = 5_000;

export function intakeConfigured(): boolean {
  return Boolean(process.env.WORKER_INTAKE_URL);
}

function config(): { url: string; secret: string } {
  const url = process.env.WORKER_INTAKE_URL?.replace(/\/$/, "");
  if (!url) throw new Error("WORKER_INTAKE_URL is not set");
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    throw new Error("WORKER_INTAKE_URL is set but INTERNAL_API_SECRET is not — refusing to call the worker unauthenticated.");
  }
  return { url, secret };
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const { url, secret } = config();
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) {
    // The status is the useful part; the body may carry the worker's own reason.
    const detail = await res.text().catch(() => "");
    throw new Error(`worker intake ${path} answered ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  return (await res.json()) as T;
}

export function intakeEnqueue(data: SyncJobData): Promise<EnqueueResult> {
  return post<EnqueueResult>("/internal/enqueue", data);
}

export async function intakePublish(event: RealtimeEvent): Promise<number> {
  const { receivers } = await post<{ receivers: number }>("/internal/publish", { event });
  return receivers;
}

/** Worker liveness for the health endpoint. Unauthenticated by design. */
export async function intakeLive(): Promise<boolean> {
  const url = process.env.WORKER_INTAKE_URL?.replace(/\/$/, "");
  if (!url) return false;
  try {
    const res = await fetch(`${url}/internal/live`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false;
  }
}
