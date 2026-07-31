/**
 * Wezesha's own workspace — the anchor for audit rows that belong to no
 * customer (granting platform admin, revoking it, step-up).
 *
 * It is a real Tenant row rather than a nullable column or a sentinel id, so
 * AuditEvent.tenantId keeps meaning one thing everywhere. It is memberless, so
 * nothing in the app can reach it: every tenant read resolves through a
 * membership and there is none.
 *
 * The slug uses underscores because workspaceSlug() strips them — no name a
 * customer types can generate it, so the row can never collide with a real
 * workspace.
 */
export const PLATFORM_TENANT_ID = "platform";
export const PLATFORM_TENANT_SLUG = "__platform__";

/** How the platform workspace is labelled where it is legitimately shown (the
 *  audit ledger and its filter) — never the raw slug. */
export const PLATFORM_TENANT_LABEL = "Platform";

/**
 * Prisma `where` fragment for "workspaces that belong to customers".
 *
 * Spread into every query that enumerates tenants to do something *to* them —
 * the nightly crons, the fleet list, the workspace-entry guard. Anything that
 * skips it hands the platform workspace a forecast job, a sales-gap
 * notification, or a row on a screen listing shops.
 *
 * Not for the audit ledger: that is the one surface where the platform
 * workspace is the point, and filtering it there would render every platform
 * event as a bare id.
 */
export const CUSTOMER_TENANTS_WHERE = { isSystem: false } as const;

/** Whether an id names the platform workspace — for guards that hold one id
 *  rather than build a query (entering a workspace, deleting one, inviting). */
export function isPlatformTenantId(tenantId: string): boolean {
  return tenantId === PLATFORM_TENANT_ID;
}
