import { NextResponse } from "next/server";
import { activeMembership, getSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { runBacktest } from "@wezesha/forecast-run";
import { withCapture } from "@/lib/observability/wrap";

/**
 * Score the forecast against what actually happened, on demand.
 *
 * The walk-forward backtest already runs monthly on the worker, and until now
 * that was the only way it ever ran — so "how accurate is the forecast?" could
 * only be answered with a figure up to a month old, and a shop that had just
 * connected could not answer it at all until the 1st came round. The accuracy
 * tab reads whatever this writes, so the same question now has a same-day
 * answer.
 *
 * Session-guarded and gated on `manage_settings`: it is a read of history that
 * WRITES a score row, and a money-blind member has no business triggering
 * either. The tenant comes from the membership, never from the request body.
 *
 * Scoring replays sales history and re-forecasts at past cutoffs; it does not
 * touch predictions, orders or stock. A shop with too little history to produce
 * a cutoff gets `rowsWritten: 0` rather than an error — that is not a failure,
 * it is a shop that cannot be scored yet.
 */
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
    if (!hasPermission(membership, "manage_settings")) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const result = await runBacktest(membership.tenantId);
    return NextResponse.json({
      rowsWritten: result.rowsWritten,
      // Said-vs-happened in units: the founder rejected error percentages, so
      // this is the shape the accuracy tab already speaks in.
      scored: result.result?.byClass.find((r) => r.abcClass === "ALL" && r.method === "run_rate") ?? null,
      degraded: result.degraded,
      methodChanged: result.methodChanged,
    });
  },
  { route: "/api/forecast/backtest", errorMessage: "backtest run failed" }
);
