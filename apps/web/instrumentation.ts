import type { Instrumentation } from "next";

/**
 * Server startup + request-error hooks. The tracker is env-gated on
 * SENTRY_DSN (see @wezesha/observability) — without it both hooks are no-ops.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initObservability } = await import("@wezesha/observability");
    await initObservability("web");
  }
}

// Mirrors WORKSPACE_COOKIE in lib/auth.ts (not imported: lib/auth drags the
// whole auth stack into the instrumentation module graph). The cookie is the
// user's active-workspace preference — unvalidated, but exactly the right
// best-effort tenant tag for an error report.
const WORKSPACE_COOKIE = "wz-workspace";

function tenantFromCookieHeader(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header.join(";") : header;
  for (const part of raw?.split(";") ?? []) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === WORKSPACE_COOKIE) {
      return part.slice(eq + 1).trim() || null;
    }
  }
  return null;
}

/** Uncaught server-side request errors (pages, server components, route
 *  handlers that don't catch) — reported with the best-effort tenant tag. */
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { captureError } = await import("@wezesha/observability");
  captureError(err, {
    tenantId: tenantFromCookieHeader(request.headers.cookie),
    path: request.path,
    routerKind: context.routerKind,
    routeType: context.routeType,
  });
};
