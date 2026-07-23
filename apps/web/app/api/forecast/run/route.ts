import { NextResponse } from "next/server";
import { activeMembership, getSession } from "@/lib/auth";
import { runForecast } from "@/lib/forecast-run/run";
import { withCapture } from "@/lib/observability/wrap";

/** Kick a forecast run for the caller's active workspace. Session-guarded;
 *  the tenant comes from the membership, never from the request body.
 *  A thrown run is captured (tenant-tagged) and answered with the same
 *  500 body as before the wrapper. */
export const POST = withCapture(
  async () => {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const membership = await activeMembership(session.user.id);
    if (!membership) {
      return NextResponse.json({ error: "no workspace" }, { status: 403 });
    }

    const result = await runForecast(membership.tenantId);
    return NextResponse.json(result);
  },
  { route: "/api/forecast/run", errorMessage: "forecast run failed" }
);
