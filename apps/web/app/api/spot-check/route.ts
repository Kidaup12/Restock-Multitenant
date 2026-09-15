import { NextResponse } from "next/server";
import { activeMembership, getSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { recordSpotCheckCount } from "@/lib/data/spot-check";
import { withCapture } from "@/lib/observability/wrap";

/**
 * Record a weekly spot-check count — what the shop physically counted for one
 * prompted SKU. The worker cron wrote the prompts (systemQty snapshot); this
 * fills in countedQty + countedAt so the card can show the drift.
 *
 * Session-guarded and gated on `manage_settings`: recording a count is a
 * settings-ish action (it feeds the stock-health picture), so a money-blind
 * MEMBER cannot write it. The tenant comes from the membership, never the body,
 * and the row id is validated to belong to that tenant inside the data layer —
 * an id from another workspace matches nothing and gets a clean 404, not a 500.
 */

const MAX_COUNT = 10_000_000; // sanity cap — a real shelf count never approaches it

export const POST = withCapture(
  async (req: Request) => {
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

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });

    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

    const countedQty = Number(body.countedQty);
    if (!Number.isFinite(countedQty) || countedQty < 0) {
      return NextResponse.json({ error: "countedQty must be zero or more" }, { status: 400 });
    }
    if (countedQty > MAX_COUNT) {
      return NextResponse.json({ error: "countedQty is too large" }, { status: 400 });
    }

    const ok = await recordSpotCheckCount(membership.tenantId, id, countedQty);
    if (!ok) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  },
  { route: "/api/spot-check", errorMessage: "could not record the spot-check count" }
);
