import { NextResponse } from "next/server";
import { activeMembership, getSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { deleteTenant } from "@/lib/offboarding/delete";
import { withCapture } from "@/lib/observability/wrap";

/**
 * Delete the active workspace — permanent, cascading, unrecoverable.
 *
 * WARNING — TEST TENANTS ONLY until the owner signs off on real-tenant offboarding
 * (production-safety rule): the flow is exercised exclusively against fixture
 * tenants the tests create and destroy themselves. Running it against a live
 * client workspace requires explicit, in-the-moment approval.
 *
 * Guards: session → OWNER role + manage_settings → typed-slug confirmation +
 * export-first (fresh "exported" AuditEvent) inside deleteTenant. The tenant
 * comes from the membership, never from the request body.
 *
 * Body: { confirmSlug: string, exportConfirmed: true }
 */
export const POST = withCapture(async (request: Request) => {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const membership = await activeMembership(session.user.id);
  if (!membership) {
    return NextResponse.json({ error: "no workspace" }, { status: 403 });
  }
  if (membership.role !== "OWNER" || !hasPermission(membership, "manage_settings")) {
    return NextResponse.json(
      { error: "Only the workspace owner can delete it." },
      { status: 403 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const { confirmSlug, exportConfirmed } = (body ?? {}) as {
    confirmSlug?: unknown;
    exportConfirmed?: unknown;
  };
  if (typeof confirmSlug !== "string") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const result = await deleteTenant({
    tenantId: membership.tenantId,
    confirmSlug,
    exportConfirmed: exportConfirmed === true,
    actorUserId: session.user.id,
    actorName: membership.displayName ?? session.user.email,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true });
});
