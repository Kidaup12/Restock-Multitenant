import { prismaForTenant, prismaService } from "@wezesha/db";
import { createShopifyClient, decryptToken } from "@wezesha/shopify";
import { EXPORT_FRESHNESS_HOURS } from "./export";

/**
 * Tenant deletion — the offboarding endgame. The schema's onDelete: Cascade
 * relations do the heavy lifting; this module owns the SAFEGUARDS in front of
 * the cascade:
 *
 *   1. typed-slug confirmation (the caller re-types the workspace slug)
 *   2. export-first: a fresh "exported" AuditEvent (written by the export
 *      route within the last 24h) must exist — a checkbox alone is not proof
 *   3. best-effort remote cleanup: Shopify webhooks are removed while the
 *      access token still exists (it dies with the row)
 *   4. a final AuditEvent written BEFORE the cascade; AuditEvent carries no
 *      Tenant FK precisely so the ledger survives the tenant
 *
 * BacktestRun and SpotCheck also carry no FK (by design); they hold tenant
 * data, so this flow removes them explicitly. AuditEvent rows are KEPT — an
 * append-only accounting ledger outlives its subject.
 */

const HOUR_MS = 3_600_000;

export type DeleteTenantRequest = {
  tenantId: string;
  /** Must equal the tenant's slug exactly — the "type the name" confirmation. */
  confirmSlug: string;
  /** Caller's assertion that an export was taken; checked against the ledger too. */
  exportConfirmed: boolean;
  actorUserId: string;
  actorName: string | null;
};

export type DeleteTenantResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

/** Best-effort: unhook the store's webhooks while we still hold a token.
 *  Failure never blocks offboarding — the app/uninstalled path and Shopify's
 *  own dead-endpoint pruning are the backstops. */
async function removeShopifyWebhooks(tenantId: string): Promise<void> {
  const connection = await prismaForTenant(tenantId).shopifyConnection.findFirst();
  if (!connection || connection.uninstalledAt) return;
  try {
    const client = createShopifyClient({
      shopDomain: connection.shopDomain,
      accessToken: decryptToken(connection.accessToken),
    });
    const result = await client.graphql<{
      webhookSubscriptions?: { edges?: Array<{ node?: { id?: string } }> };
    }>(
      `query { webhookSubscriptions(first: 50) { edges { node { id } } } }`
    );
    for (const edge of result.webhookSubscriptions?.edges ?? []) {
      if (!edge.node?.id) continue;
      await client.graphql(
        `mutation($id: ID!) { webhookSubscriptionDelete(id: $id) { userErrors { message } } }`,
        { id: edge.node.id }
      );
    }
  } catch (err) {
    console.error(`offboarding: webhook removal failed for ${tenantId} (continuing)`, err);
  }
}

export async function deleteTenant(request: DeleteTenantRequest): Promise<DeleteTenantResult> {
  const { tenantId, confirmSlug, exportConfirmed, actorUserId, actorName } = request;

  const tenant = await prismaForTenant(tenantId).tenant.findUnique({
    where: { id: tenantId },
    select: { slug: true, name: true },
  });
  if (!tenant) return { ok: false, status: 404, error: "workspace not found" };

  if (confirmSlug !== tenant.slug) {
    return { ok: false, status: 400, error: "confirmation does not match the workspace slug" };
  }
  if (exportConfirmed !== true) {
    return { ok: false, status: 400, error: "export the workspace data first" };
  }
  const freshSince = new Date(Date.now() - EXPORT_FRESHNESS_HOURS * HOUR_MS);
  const freshExport = await prismaService.auditEvent.findFirst({
    where: { tenantId, entity: "Tenant", action: "exported", createdAt: { gte: freshSince } },
    select: { id: true },
  });
  if (!freshExport) {
    return {
      ok: false,
      status: 409,
      error: `no export in the last ${EXPORT_FRESHNESS_HOURS}h — download a fresh export, then retry`,
    };
  }

  await removeShopifyWebhooks(tenantId);

  // The ledger's obituary — written before the cascade, survives it (no FK).
  await prismaService.auditEvent.create({
    data: {
      tenantId,
      entity: "Tenant",
      entityId: tenantId,
      action: "deleted",
      actorUserId,
      actorName,
      meta: { slug: tenant.slug, name: tenant.name },
    },
  });

  // Non-FK tenant data first (the cascade can't reach it), then the cascade.
  await prismaService.backtestRun.deleteMany({ where: { tenantId } });
  await prismaService.spotCheck.deleteMany({ where: { tenantId } });
  await prismaService.tenant.delete({ where: { id: tenantId } });

  return { ok: true };
}
