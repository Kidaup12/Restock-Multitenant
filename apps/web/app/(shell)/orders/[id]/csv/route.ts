import { NextResponse, type NextRequest } from "next/server";
import { activeMembership, getSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { getPoDocument } from "@/lib/data/orders";
import { poCsvFilenameBase, toPoCsv, type PoCsvFormat } from "@/lib/po/po-csv";
import { timestampedFilename } from "@/lib/export/csv";
import { withCapture } from "@/lib/observability/wrap";

/**
 * GET /orders/[id]/csv — download a purchase order as CSV.
 *
 * Format is chosen by `?format=quickbooks` (the QBO import template, default) or
 * `?format=generic` (a plain supplier sheet). Session-guarded and scoped to the
 * caller's active membership; any authenticated member may export. The PO is
 * loaded tenant-scoped through getPoDocument (the RLS tenant client), so an id
 * that isn't this workspace's returns 404 — the same document the print view
 * reads, redaction and all: a money-blind member's export carries no costs (the
 * QuickBooks Rate/Amount cells come blank; the generic sheet drops those columns).
 */
export const GET = withCapture(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const membership = await activeMembership(session.user.id);
    if (!membership) {
      return NextResponse.json({ error: "no workspace" }, { status: 403 });
    }

    const format: PoCsvFormat =
      new URL(req.url).searchParams.get("format") === "generic" ? "generic" : "quickbooks";

    const canViewCosts = hasPermission(membership, "view_costs");
    const doc = await getPoDocument(membership.tenantId, id, { canViewCosts });
    if (!doc) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const csv = toPoCsv(doc, format, canViewCosts);
    const filename = timestampedFilename(poCsvFilenameBase(doc, format), "csv");
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  },
  { route: "/orders/[id]/csv", errorMessage: "po csv build failed" }
);
