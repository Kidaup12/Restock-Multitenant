import type { ErrorEvent, NodeOptions } from "@sentry/node";

export {
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_KEY,
  WORKER_HEARTBEAT_TTL_SECONDS,
} from "./uptime";

/**
 * Thin, env-gated wrapper over the error tracker. Without SENTRY_DSN nothing
 * initializes — `@sentry/node` is not even imported (dynamic import behind the
 * DSN check), so unset environments pay zero overhead and captureError is a
 * plain early-return. With a DSN, every event carries a `service` tag and, when
 * the caller can resolve one, a `tenantId` tag — the triage key for a
 * multi-tenant system — and passes through scrubEvent before leaving the
 * process.
 *
 * Process-level fatal handling stays with each service (the wrapper strips
 * Sentry's own OnUncaughtException/OnUnhandledRejection integrations), so a
 * service's shutdown behavior never changes because a DSN appeared.
 */

type SentryModule = typeof import("@sentry/node");

let sentry: SentryModule | null = null;

/** Tag bag for captureError. tenantId/jobId are the conventional keys; any
 *  extra string/number tags ride along. Null/undefined values are dropped. */
export type ErrorTags = {
  tenantId?: string | null;
  jobId?: string | null;
  queue?: string;
  [key: string]: string | number | null | undefined;
};

export interface InitOptions {
  /** Override the SENTRY_DSN env read (tests). */
  dsn?: string;
  /** Override the environment name (defaults SENTRY_ENVIRONMENT, then NODE_ENV). */
  environment?: string;
  /** Custom transport (tests inject a recorder; production uses the default). */
  transport?: NodeOptions["transport"];
}

/** True once init found a DSN and the tracker is live. */
export function isEnabled(): boolean {
  return sentry !== null;
}

/**
 * Initialize the tracker for one service ("web" | "worker" | "ws-gateway").
 * No SENTRY_DSN (and no options.dsn) → returns false and the module stays a
 * complete no-op. Safe to call once at process start.
 */
export async function initObservability(
  service: string,
  options: InitOptions = {}
): Promise<boolean> {
  const dsn = options.dsn ?? process.env.SENTRY_DSN;
  if (!dsn) return false;

  let mod: SentryModule;
  try {
    mod = await import("@sentry/node");
  } catch (err) {
    // A DSN is set but the SDK can't load (e.g. stripped from a bundle) —
    // say so loudly and keep the service running without tracking.
    console.error(`observability: SENTRY_DSN set but @sentry/node failed to load (${service})`, err);
    return false;
  }
  mod.init({
    dsn,
    environment:
      options.environment ??
      process.env.SENTRY_ENVIRONMENT ??
      process.env.NODE_ENV ??
      "development",
    release: process.env.SENTRY_RELEASE,
    initialScope: { tags: { service } },
    beforeSend: scrubEvent,
    // Fatal-error handling belongs to the service's own process handlers —
    // Sentry's versions would exit on their own schedule.
    integrations: (defaults) =>
      defaults.filter(
        (i) => i.name !== "OnUncaughtException" && i.name !== "OnUnhandledRejection"
      ),
    ...(options.transport ? { transport: options.transport } : {}),
  });
  sentry = mod;
  return true;
}

/**
 * Report an error with tags. ALWAYS tags tenantId when the caller provides
 * one — that tag is what makes a multi-tenant tracker searchable. A plain
 * no-op until initObservability found a DSN.
 */
export function captureError(err: unknown, tags: ErrorTags = {}): void {
  if (!sentry) return;
  const clean: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(tags)) {
    if (value !== null && value !== undefined) clean[key] = value;
  }
  sentry.captureException(err, { tags: clean });
}

/** Drain pending events (call before a fatal process exit). No-op when unset. */
export async function flushObservability(timeoutMs = 2000): Promise<void> {
  if (!sentry) return;
  await sentry.flush(timeoutMs).catch(() => {});
}

/** Tests only: forget the initialized module so init gating can be re-proven. */
export function _resetForTests(): void {
  sentry = null;
}

// ── Scrubbing ────────────────────────────────────────────────────────────────

/** Header names that never leave the process (case-insensitive). */
const SENSITIVE_HEADERS = [
  "cookie",
  "set-cookie",
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "x-shopify-access-token",
];

/**
 * Token-like strings, redacted wherever they appear in message text:
 * Shopify tokens (shpat_/shpca_/shpss_), Bearer values, long hex (32+), and
 * long base64 runs (40+). Short ids like cuids (25 chars, not hex) survive —
 * tenant/job ids in messages are the point of the tags, not a secret.
 */
const TOKEN_PATTERN =
  /\b(?:shpat|shpca|shpss)_[A-Za-z0-9]+\b|\bBearer\s+[A-Za-z0-9\-._~+/]+=*|\b[A-Fa-f0-9]{32,}\b|\b[A-Za-z0-9+/]{40,}={0,2}\b/g;

function redact(text: string): string {
  return text.replace(TOKEN_PATTERN, "[redacted]");
}

/**
 * beforeSend hook (exported pure for tests): drop cookies and credential
 * headers, and redact token-like strings from the message, exception values,
 * and stack-frame source context (the contextLines integration copies raw
 * source lines into every frame — a literal secret in code would ride along).
 * Never blocks an event — a scrubbed report beats a dropped one.
 */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  if (event.request) {
    delete event.request.cookies;
    if (event.request.headers) {
      for (const name of Object.keys(event.request.headers)) {
        if (SENSITIVE_HEADERS.includes(name.toLowerCase())) {
          delete event.request.headers[name];
        }
      }
    }
    if (typeof event.request.query_string === "string") {
      event.request.query_string = redact(event.request.query_string);
    }
  }
  if (typeof event.message === "string") {
    event.message = redact(event.message);
  }
  for (const exception of event.exception?.values ?? []) {
    if (typeof exception.value === "string") {
      exception.value = redact(exception.value);
    }
    for (const frame of exception.stacktrace?.frames ?? []) {
      if (typeof frame.context_line === "string") frame.context_line = redact(frame.context_line);
      if (frame.pre_context) frame.pre_context = frame.pre_context.map(redact);
      if (frame.post_context) frame.post_context = frame.post_context.map(redact);
      if (frame.vars) delete frame.vars; // local variable capture: values are uncontrolled
    }
  }
  return event;
}
