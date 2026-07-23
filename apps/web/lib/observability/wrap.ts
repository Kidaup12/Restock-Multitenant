import { NextResponse } from "next/server";
import { captureError } from "@wezesha/observability";
import { activeMembership, getSession } from "@/lib/auth";

/**
 * Route-handler capture wrapper. Handlers that already return their own 4xx
 * responses are untouched — this only catches what they THROW, reports it
 * tagged with the caller's tenantId (resolved lazily, on the error path only),
 * and answers a stable 500 instead of Next's opaque error page.
 */

type RouteHandler<Args extends unknown[]> = (...args: Args) => Promise<Response>;

export interface WithCaptureOptions {
  /** Route tag when the handler takes no Request (e.g. a bare POST()). */
  route?: string;
  /** Body of the 500 response; defaults to "internal error". */
  errorMessage?: string;
}

/** Best-effort tenant for tagging: the session's active membership. Never
 *  throws — an unresolvable tenant must not mask the original error. */
async function resolveTenantId(): Promise<string | null> {
  try {
    const session = await getSession();
    if (!session) return null;
    const membership = await activeMembership(session.user.id);
    return membership?.tenantId ?? null;
  } catch {
    return null;
  }
}

export function withCapture<Args extends unknown[]>(
  handler: RouteHandler<Args>,
  options: WithCaptureOptions = {}
): RouteHandler<Args> {
  return async (...args: Args): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (err) {
      const first = args[0];
      const route =
        first instanceof Request ? new URL(first.url).pathname : (options.route ?? "unknown");
      console.error(`${route} failed:`, err);
      captureError(err, { tenantId: await resolveTenantId(), route });
      return NextResponse.json(
        { error: options.errorMessage ?? "internal error" },
        { status: 500 }
      );
    }
  };
}
