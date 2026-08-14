import { NextResponse } from "next/server";
import { activeMembership, getSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { exportTenantStream } from "@/lib/offboarding/export";
import { withCapture } from "@/lib/observability/wrap";

/**
 * Download the active workspace as one JSON archive. OWNER-only (role AND the
 * manage_settings permission): the export contains everything the tenant
 * owns — costs, suppliers, sales — so it is the most sensitive read in the
 * app. The tenant comes from the membership, never the request. Streaming a
 * completed export also writes the "exported" AuditEvent the delete flow's
 * export-first safeguard checks for.
 *
 * Capture covers the guards and the stream's construction; a fault raised once
 * the archive is already streaming happens after the return and is not caught.
 */
export const GET = withCapture(async () => {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const membership = await activeMembership(session.user.id);
  if (!membership) {
    return NextResponse.json({ error: "no workspace" }, { status: 403 });
  }
  if (membership.role !== "OWNER" || !hasPermission(membership, "manage_settings")) {
    return NextResponse.json({ error: "Only the workspace owner can export it." }, { status: 403 });
  }

  const date = new Date().toISOString().slice(0, 10);
  const filename = `wezesha-export-${membership.tenant.slug}-${date}.json`;
  const stream = exportTenantStream(membership.tenantId, {
    userId: session.user.id,
    name: membership.displayName ?? session.user.email,
  });
  return new Response(stream, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}, { route: "/api/ops/export" });
