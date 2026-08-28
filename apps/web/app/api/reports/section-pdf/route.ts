import { NextRequest, NextResponse } from "next/server";
import { activeMembership, getSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { renderSectionPdf, type SectionPdfData } from "@/lib/reports/section-pdf";
import { withCapture } from "@/lib/observability/wrap";

// react-pdf needs the Node runtime (not edge).
export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * POST /api/reports/section-pdf — render ONE analytics section as a branded PDF.
 *
 * The client sends the already-computed table it is showing (title, columns,
 * rows, optional KPI cards) — so whatever filter is on screen is honoured by
 * construction — and the server formats it. Keeps react-pdf out of the browser
 * bundle and the output consistent with the shop report.
 *
 * Session-guarded and scoped to the caller's active membership; any authenticated
 * member may export. The body is untrusted, so it is hardened: title capped,
 * columns cut to a sane maximum (empty = 400), rows capped and every cell coerced
 * to a string. The shop name/timezone and the cost-visibility flag come from the
 * membership, never from the request.
 */
export const POST = withCapture(
  async (req: NextRequest) => {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const membership = await activeMembership(session.user.id);
    if (!membership) {
      return NextResponse.json({ error: "no workspace" }, { status: 403 });
    }

    let body: {
      title?: string;
      subtitle?: string;
      kpis?: { label: string; value: string }[];
      columns?: { header: string; width?: number; align?: "left" | "right" }[];
      rows?: (string | number | null)[][];
      note?: string;
    };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "invalid body" }, { status: 400 });
    }

    const title = (body.title ?? "Report").toString().slice(0, 80);
    const columns = Array.isArray(body.columns) ? body.columns.slice(0, 12) : [];
    if (columns.length === 0) {
      return NextResponse.json({ error: "no columns" }, { status: 400 });
    }

    // Coerce every cell to a string; cap rows so a huge list can't blow the render.
    const rows = (Array.isArray(body.rows) ? body.rows : [])
      .slice(0, 500)
      .map((r) => columns.map((_, i) => (r[i] == null ? "" : String(r[i]))));

    const data: SectionPdfData = {
      shop: { name: membership.tenant.name, timezone: membership.tenant.timezone },
      generatedAt: new Date(),
      title,
      subtitle: body.subtitle?.toString().slice(0, 160),
      kpis: Array.isArray(body.kpis)
        ? body.kpis.slice(0, 5).map((k) => ({
            label: String(k.label).slice(0, 40),
            value: String(k.value).slice(0, 40),
          }))
        : undefined,
      columns,
      rows,
      note: body.note?.toString().slice(0, 200),
      canSeeCosts: hasPermission(membership, "view_costs"),
    };

    const buffer = await renderSectionPdf(data);
    const filename = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "report"}.pdf`;
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  },
  { route: "/api/reports/section-pdf", errorMessage: "section pdf build failed" }
);
