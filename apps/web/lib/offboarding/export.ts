import { prismaForTenant, prismaService } from "@wezesha/db";

/**
 * Full tenant export: one JSON document holding the tenant row and every
 * tenant-scoped table, streamed so a large workspace never has to fit in one
 * server buffer. Every read runs on the RLS-enforced tenant client —
 * isolation by construction, not by query discipline.
 *
 * The export-manifest test cross-checks EXPORTED_MODELS against the Prisma
 * schema (every model carrying tenantId must be listed), so a new tenant
 * table cannot silently fall out of the export.
 */

const BATCH = 500;

/** How long an export stays "fresh" for the delete flow's export-first check. */
export const EXPORT_FRESHNESS_HOURS = 24;

type DelegateLike = {
  findMany(args: {
    orderBy: { id: "asc" };
    take: number;
    cursor?: { id: string };
    skip?: number;
    omit?: Record<string, boolean>;
  }): Promise<Array<Record<string, unknown>>>;
};

/**
 * Every tenant-scoped model, JSON key = model name, delegate = tenant-client
 * property. `omit` strips columns that must not leave the database even in an
 * owner export (the Shopify token ciphertext).
 */
export const EXPORTED_MODELS: ReadonlyArray<{
  model: string;
  delegate: string;
  omit?: Record<string, boolean>;
}> = [
  { model: "Membership", delegate: "membership" },
  { model: "TenantConfig", delegate: "tenantConfig" },
  { model: "Product", delegate: "product" },
  { model: "Supplier", delegate: "supplier" },
  { model: "Location", delegate: "location" },
  { model: "InventoryLevel", delegate: "inventoryLevel" },
  { model: "InventorySnapshot", delegate: "inventorySnapshot" },
  { model: "WarehouseLocationMap", delegate: "warehouseLocationMap" },
  { model: "IgnoreRule", delegate: "ignoreRule" },
  { model: "SavedFilter", delegate: "savedFilter" },
  { model: "SalesHistory", delegate: "salesHistory" },
  { model: "PosSale", delegate: "posSale" },
  { model: "PosSaleLine", delegate: "posSaleLine" },
  { model: "LocationClosure", delegate: "locationClosure" },
  { model: "MonthlyContext", delegate: "monthlyContext" },
  { model: "Promo", delegate: "promo" },
  { model: "OwnerPrior", delegate: "ownerPrior" },
  { model: "Prediction", delegate: "prediction" },
  { model: "ForecastRecommendation", delegate: "forecastRecommendation" },
  { model: "BacktestRun", delegate: "backtestRun" },
  { model: "SpotCheck", delegate: "spotCheck" },
  { model: "Order", delegate: "order" },
  { model: "PurchaseOrder", delegate: "purchaseOrder" },
  { model: "PurchaseOrderLine", delegate: "purchaseOrderLine" },
  { model: "DistributionPlan", delegate: "distributionPlan" },
  { model: "DistributionPlanLine", delegate: "distributionPlanLine" },
  { model: "ProductPlanOverride", delegate: "productPlanOverride" },
  { model: "ShopifyConnection", delegate: "shopifyConnection", omit: { accessToken: true } },
  // clientId is exportable (it is not a secret and the shop owns it); the
  // signing secret is not, same rule as the access token.
  { model: "ShopifyAppCredential", delegate: "shopifyAppCredential", omit: { apiSecret: true } },
  { model: "IngestCursor", delegate: "ingestCursor" },
  { model: "SyncRun", delegate: "syncRun" },
  { model: "Notification", delegate: "notification" },
  { model: "AuditEvent", delegate: "auditEvent" },
  // Envelopes only — the ledger never holds a message body, so there is nothing
  // to omit here. Rows with no tenant (sign-in codes) belong to no workspace and
  // the RLS policy keeps them out of every export by construction.
  { model: "EmailLog", delegate: "emailLog" },
];

async function* exportChunks(
  tenantId: string,
  actor: { userId: string; name: string | null }
): AsyncGenerator<string> {
  const db = prismaForTenant(tenantId);
  const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new Error("tenant not found");

  yield `{"format":"wezesha-tenant-export","version":1,"exportedAt":${JSON.stringify(
    new Date().toISOString()
  )},"tenant":${JSON.stringify(tenant)},"tables":{`;

  const rowCounts: Record<string, number> = {};
  let firstTable = true;
  for (const { model, delegate, omit } of EXPORTED_MODELS) {
    yield `${firstTable ? "" : ","}${JSON.stringify(model)}:[`;
    firstTable = false;

    const table = (db as unknown as Record<string, DelegateLike>)[delegate];
    if (!table) throw new Error(`export: unknown delegate ${delegate}`);
    let cursor: string | null = null;
    let count = 0;
    for (;;) {
      const rows: Array<Record<string, unknown>> = await table.findMany({
        orderBy: { id: "asc" },
        take: BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        ...(omit ? { omit } : {}),
      });
      if (rows.length === 0) break;
      const json = rows.map((row) => JSON.stringify(row)).join(",");
      yield count === 0 ? json : `,${json}`;
      count += rows.length;
      cursor = rows[rows.length - 1]!.id as string;
      if (rows.length < BATCH) break;
    }
    rowCounts[model] = count;
    yield "]";
  }
  yield "}}";

  // Ledger entry AFTER the last byte: this is what the delete flow's
  // export-first safeguard checks for. Audit writes go through the service
  // client — an audit log the tenant role could filter is not an audit log.
  await prismaService.auditEvent.create({
    data: {
      tenantId,
      entity: "Tenant",
      entityId: tenantId,
      action: "exported",
      actorUserId: actor.userId,
      actorName: actor.name,
      meta: { rowCounts },
    },
  });
}

/** The export as a web ReadableStream, ready to hand to a Response. */
export function exportTenantStream(
  tenantId: string,
  actor: { userId: string; name: string | null }
): ReadableStream<Uint8Array> {
  const iterator = exportChunks(tenantId, actor);
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(encoder.encode(value));
    },
    cancel() {
      void iterator.return(undefined);
    },
  });
}

/** Convenience for tests and non-streaming callers: the whole document. */
export async function exportTenantJson(
  tenantId: string,
  actor: { userId: string; name: string | null }
): Promise<string> {
  let out = "";
  for await (const chunk of exportChunks(tenantId, actor)) out += chunk;
  return out;
}
