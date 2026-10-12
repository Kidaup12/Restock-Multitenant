import { NextResponse, type NextRequest } from "next/server";
import { activeMembership, getSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { getPoDocument } from "@/lib/data/orders";
import { poXlsxBuffer, poXlsxFilename } from "@/lib/po/po-xlsx";
import { withCapture } from "@/lib/observability/wrap";

// exceljs is a Node library (streams, Buffer) — not edge.
export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * GET /orders/[id]/xlsx — download a purchase order as an .xlsx workbook.
 *
 * Session-guarded and scoped to the caller's active membership; any authenticated
 * member may export. The PO is loaded tenant-scoped through getPoDocument (the RLS
 * tenant client), so an id that isn't this workspace's returns 404 — the same
 * document the print view reads, redaction and all: a money-blind member's
 * workbook drops the Unit cost / Line total columns entirely.
 */
export const GET = withCapture(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const membership = await activeMembership(session.user.id);
    if (!membership) {
      return NextResponse.json({ error: "no workspace" }, { status: 403 });
    }

    const canViewCosts = hasPermission(membership, "view_costs");
    const doc = await getPoDocument(membership.tenantId, id, { canViewCosts });
    if (!doc) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const buffer = await poXlsxBuffer(doc, { canViewCosts });
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${poXlsxFilename(doc)}"`,
        "Cache-Control": "no-store",
      },
    });
  },
  { route: "/orders/[id]/xlsx", errorMessage: "po xlsx build failed" }
);
