import { prismaService } from "@wezesha/db";
import type { AdminActor } from "@/lib/admin/gate";

/**
 * Admin-console audit trail. Every admin action against a customer workspace
 * (entering it, triggering its sync, leaving it) writes one AuditEvent row so
 * "every session logged" is a queryable fact, not a promise. Writes ride the
 * service client — the iron rule for the ledger: rows must land regardless of
 * any tenant-scoped RLS context, and no tenant role may filter them.
 */

/** entity="AdminSession": workspace entry/exit. entity="AdminSync": sync triggers. */
export const ADMIN_AUDIT_ACTIONS = [
  "impersonation_start",
  "impersonation_end",
  "admin_sync_trigger",
] as const;

export type AdminAuditAction = (typeof ADMIN_AUDIT_ACTIONS)[number];

/** One admin-surface audit row. entityId is the tenant acted on; the admin's
 *  identity lands in actorUserId/actorName plus meta.adminEmail. */
export async function recordAdminEvent(opts: {
  tenantId: string;
  action: AdminAuditAction;
  admin: AdminActor;
  meta?: Record<string, unknown>;
}): Promise<void> {
  await prismaService.auditEvent.create({
    data: {
      tenantId: opts.tenantId,
      entity: opts.action === "admin_sync_trigger" ? "AdminSync" : "AdminSession",
      entityId: opts.tenantId,
      action: opts.action,
      actorUserId: opts.admin.userId,
      actorName: opts.admin.name,
      meta: { adminEmail: opts.admin.email, ...opts.meta },
    },
  });
}

export type AuditRow = {
  id: string;
  tenantId: string;
  tenantName: string | null;
  entity: string;
  entityId: string;
  action: string;
  actorName: string | null;
  meta: unknown;
  createdAt: Date;
};

export type AuditPage = {
  rows: AuditRow[];
  /** Pass back as `cursor` for the next (older) page; null at the end. */
  nextCursor: string | null;
};

export const AUDIT_PAGE_SIZE = 50;

/**
 * Newest-first page of AuditEvents across tenants, optionally narrowed to one
 * tenant and/or one action. Admin-console evidence surface — the ONE read
 * path that deliberately spans tenants, so it runs on the service client
 * behind requireAdmin (a per-tenant client could only ever show its own slice).
 */
export async function listAuditEvents(opts: {
  tenantId?: string | null;
  action?: string | null;
  cursor?: string | null;
  limit?: number;
} = {}): Promise<AuditPage> {
  const limit = opts.limit ?? AUDIT_PAGE_SIZE;
  const events = await prismaService.auditEvent.findMany({
    where: {
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
      ...(opts.action ? { action: opts.action } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1, // one extra row = "there is a next page"
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });

  const page = events.slice(0, limit);
  // Resolve tenant names in one query; deleted tenants render as id-only.
  const tenantIds = [...new Set(page.map((e) => e.tenantId))];
  const tenants = tenantIds.length
    ? await prismaService.tenant.findMany({
        where: { id: { in: tenantIds } },
        select: { id: true, name: true },
      })
    : [];
  const nameById = new Map(tenants.map((t) => [t.id, t.name]));

  return {
    rows: page.map((e) => ({
      id: e.id,
      tenantId: e.tenantId,
      tenantName: nameById.get(e.tenantId) ?? null,
      entity: e.entity,
      entityId: e.entityId,
      action: e.action,
      actorName: e.actorName,
      meta: e.meta,
      createdAt: e.createdAt,
    })),
    nextCursor: events.length > limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

/** Distinct actions present in the ledger — feeds the audit filter dropdown. */
export async function listAuditActions(): Promise<string[]> {
  // Cross-tenant by design: the filter must offer every action any tenant has.
  const rows = await prismaService.auditEvent.findMany({
    distinct: ["action"],
    select: { action: true },
    orderBy: { action: "asc" },
  });
  return rows.map((r) => r.action);
}
