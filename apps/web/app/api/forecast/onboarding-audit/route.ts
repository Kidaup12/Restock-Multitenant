import { NextResponse } from "next/server";
import { activeMembership, getSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { runOnboardingAudit } from "@wezesha/forecast-run";
import { withCapture } from "@/lib/observability/wrap";

/**
 * Tune the forecast to how this shop actually sells, on demand.
 *
 * The audit runs a nested backtest against the shop's own sales history and,
 * if the numbers support it, moves the forecast onto the routing that fits that
 * shop best. Until now it only ran as part of onboarding on the worker, so a
 * shop that had accrued more history since could not ask for a re-tune — this
 * gives the owner a button that does it same-day.
 *
 * Session-guarded and gated on `manage_settings`: it can change how the shop's
 * forecast is produced, and a money-blind member has no business triggering
 * that. The tenant comes from the membership, never from the request body.
 *
 * The response is deliberately thin — whether it ran, whether it changed
 * anything, and a neutral reason when it did not. The internal tier/routing the
 * outcome carries never crosses to the client: it would leak how the forecast
 * is wired, so it is dropped here.
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

    const outcome = await runOnboardingAudit(membership.tenantId);
    // Only the shop-facing facts. `tier` (and anything else the outcome carries)
    // is internal routing and is intentionally omitted so no engine detail can
    // surface in the browser.
    return NextResponse.json({
      ran: outcome.ran,
      changed: outcome.changed,
      reason: outcome.reason ?? null,
    });
  },
  { route: "/api/forecast/onboarding-audit", errorMessage: "onboarding audit failed" }
);
