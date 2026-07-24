import { prismaService } from "../src/client";

/**
 * Two-tenant fixture for the isolation suite. Every tenant-scoped model MUST
 * have a data builder here — the suite cross-checks this list against the
 * Prisma DMMF and fails loudly when a new model is missing, so coverage cannot
 * rot silently.
 *
 * A builder returns a valid `create` data object for the given tenant. The
 * `key` suffix keeps unique fields collision-free when the suite creates extra
 * rows (e.g. the cross-tenant WITH CHECK probe).
 */
export const SLUG_A = "iso-test-a";
export const SLUG_B = "iso-test-b";

type Builder = (tenantId: string, key: string) => Record<string, unknown>;

export const builders: Record<string, Builder> = {
  // Membership now FKs to the auth User table, so the builder creates its user
  // (global table, no RLS — the membership row is still the WITH CHECK target).
  Membership: (tenantId, key) => ({
    role: "OWNER",
    displayName: `member-${key}`,
    tenant: { connect: { id: tenantId } },
    user: {
      create: {
        id: `iso-user-${key}`,
        name: `member-${key}`,
        email: `member-${key}@iso-test.example`,
      },
    },
  }),
  TenantConfig: (tenantId) => ({
    tenantId,
    alertEmail: "alerts@example.test",
  }),

  // Catalog & inventory. Builders needing parent rows (Product/Location/…) use
  // nested creates, so the WITH CHECK probe exercises RLS on the parents too.
  Product: (tenantId, key) => ({
    tenantId,
    sku: `sku-${key}`,
    title: `Product ${key}`,
  }),
  Supplier: (tenantId, key) => ({
    tenantId,
    name: `supplier-${key}`,
  }),
  Location: (tenantId, key) => ({
    tenantId,
    name: `location-${key}`,
  }),
  InventoryLevel: (tenantId, key) => ({
    tenantId,
    location: { create: { tenantId, name: `loc-il-${key}` } },
    product: { create: { tenantId, sku: `sku-il-${key}`, title: `Product il-${key}` } },
  }),
  InventorySnapshot: (tenantId, key) => ({
    date: new Date("2026-01-01T00:00:00Z"),
    onHand: 5,
    tenant: { connect: { id: tenantId } },
    product: { create: { tenantId, sku: `sku-is-${key}`, title: `Product is-${key}` } },
  }),
  WarehouseLocationMap: (tenantId, key) => ({
    warehouseName: `warehouse-${key}`,
    tenant: { connect: { id: tenantId } },
    location: { create: { tenantId, name: `loc-wm-${key}` } },
  }),
  IgnoreRule: (tenantId, key) => ({
    tenantId,
    kind: "till_sku",
    value: `junk-${key}`,
  }),
  LocationClosure: (tenantId, key) => ({
    date: new Date("2026-01-01T00:00:00Z"),
    tenant: { connect: { id: tenantId } },
    location: { create: { tenantId, name: `loc-cl-${key}` } },
  }),
  SavedFilter: (tenantId, key) => ({
    tenantId,
    userId: `00000000-0000-4000-8000-${key.padStart(12, "0")}`,
    page: "products",
    name: `filter-${key}`,
    query: {},
  }),

  // Sales & forecasting
  SalesHistory: (tenantId, key) => ({
    date: new Date("2026-01-01T00:00:00Z"),
    quantity: 1,
    revenueKes: 100,
    tenant: { connect: { id: tenantId } },
    product: { create: { tenantId, sku: `sku-sh-${key}`, title: `Product sh-${key}` } },
  }),
  PosSale: (tenantId, key) => ({
    tenantId,
    externalId: `pos-${key}`,
    date: new Date("2026-01-01T00:00:00Z"),
    createdBy: `staff-${key}`,
  }),
  PosSaleLine: (tenantId, key) => ({
    tenantId,
    sku: `sku-pl-${key}`,
    productName: `Product pl-${key}`,
    posSale: {
      create: {
        tenantId,
        externalId: `pos-pl-${key}`,
        date: new Date("2026-01-01T00:00:00Z"),
        createdBy: `staff-${key}`,
      },
    },
  }),
  MonthlyContext: (tenantId, key) => ({
    tenantId,
    month: `2026-${key}`,
  }),
  Promo: (tenantId) => ({
    tenantId,
    startDate: new Date("2026-01-01T00:00:00Z"),
    endDate: new Date("2026-01-07T00:00:00Z"),
  }),
  Prediction: (tenantId, key) => ({
    layer1Forecast30d: 10,
    layer1Confidence: 0.5,
    layer2Adjustment: 0,
    finalForecast30d: 10,
    daysUntilStockout: 30,
    recommendedQty: 5,
    safetyStock: 2,
    reorderPoint: 3,
    confidence: 0.5,
    reasoning: "seed",
    urgency: "low",
    signals: "seed",
    tenant: { connect: { id: tenantId } },
    product: { create: { tenantId, sku: `sku-pr-${key}`, title: `Product pr-${key}` } },
  }),
  BacktestRun: (tenantId) => ({
    tenantId,
    mae: 1,
    bias: 0,
    sampleSize: 10,
  }),
  OwnerPrior: (tenantId, key) => ({
    tenantId,
    scope: "product",
    scopeValue: `prod-${key}`,
    expectedUnits: 30,
  }),
  SpotCheck: (tenantId, key) => ({
    tenantId,
    productId: `spot-product-${key}`,
    weekKey: `2026-W01-${key}`,
    systemQty: 5,
  }),

  // Purchasing & audit
  Order: (tenantId, key) => ({
    tenant: { connect: { id: tenantId } },
    prediction: {
      create: {
        layer1Forecast30d: 10,
        layer1Confidence: 0.5,
        layer2Adjustment: 0,
        finalForecast30d: 10,
        daysUntilStockout: 30,
        recommendedQty: 5,
        safetyStock: 2,
        reorderPoint: 3,
        confidence: 0.5,
        reasoning: "seed",
        urgency: "low",
        signals: "seed",
        tenant: { connect: { id: tenantId } },
        product: { create: { tenantId, sku: `sku-or-${key}`, title: `Product or-${key}` } },
      },
    },
  }),
  PurchaseOrder: (tenantId, key) => ({
    tenantId,
    poNumber: `PO-${key}`,
  }),
  PurchaseOrderLine: (tenantId, key) => ({
    tenantId,
    sku: `sku-pol-${key}`,
    title: `Product pol-${key}`,
    quantity: 1,
    unitCostKes: 100,
    lineTotalKes: 100,
    purchaseOrder: { create: { tenantId, poNumber: `PO-L-${key}` } },
    product: { create: { tenantId, sku: `sku-pol-${key}`, title: `Product pol-${key}` } },
  }),
  DistributionPlan: (tenantId, key) => ({
    tenant: { connect: { id: tenantId } },
    fromLocation: { create: { tenantId, name: `loc-dp-${key}` } },
  }),
  DistributionPlanLine: (tenantId, key) => ({
    tenantId,
    productId: `plan-product-${key}`,
    sku: `sku-dpl-${key}`,
    title: `Product dpl-${key}`,
    qty: 1,
    plan: {
      create: {
        tenant: { connect: { id: tenantId } },
        fromLocation: { create: { tenantId, name: `loc-dpl-from-${key}` } },
      },
    },
    toLocation: { create: { tenantId, name: `loc-dpl-to-${key}` } },
  }),
  AuditEvent: (tenantId, key) => ({
    tenantId,
    entity: "PurchaseOrder",
    entityId: `entity-${key}`,
    action: "created",
  }),

  // Integrations (Shopify)
  ShopifyConnection: (tenantId, key) => ({
    tenantId,
    shopDomain: `${key}.myshopify.com`,
    accessToken: `ciphertext-${key}`,
    scopes: "read_products",
  }),
  IngestCursor: (tenantId, key) => ({
    tenantId,
    source: "shopify",
    resource: `resource-${key}`,
    cursor: new Date("2026-01-01T00:00:00Z"),
  }),
  Notification: (tenantId, key) => ({
    tenantId,
    kind: "sync_failed",
    title: `notification-${key}`,
  }),
};

export type SeededTenants = { a: { id: string; slug: string }; b: { id: string; slug: string } };

/** Drop and recreate both fixture tenants plus one row of every scoped model. */
export async function seedTwoTenants(): Promise<SeededTenants> {
  await prismaService.tenant.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
  // Fixture auth users survive the tenant cascade (User is global) — clear them too.
  await prismaService.user.deleteMany({ where: { id: { startsWith: "iso-user-" } } });
  const a = await prismaService.tenant.create({ data: { name: "Iso Test A", slug: SLUG_A } });
  const b = await prismaService.tenant.create({ data: { name: "Iso Test B", slug: SLUG_B } });

  // Per-run-unique key prefix: models without a tenant FK (BacktestRun,
  // SpotCheck, AuditEvent) survive the tenant-cascade cleanup, so any unique
  // key built from a bare `a${n}` would collide with a leftover row from an
  // earlier or concurrent run. The prefix makes every run's keys disjoint.
  const run = Date.now().toString(36);
  let n = 0;
  for (const [model, build] of Object.entries(builders)) {
    const delegate = (prismaService as unknown as Record<string, { create: (a: { data: unknown }) => Promise<unknown> } | undefined>)[
      model.charAt(0).toLowerCase() + model.slice(1)
    ];
    if (!delegate) throw new Error(`no client delegate for model ${model} — regenerate the client?`);
    await delegate.create({ data: build(a.id, `${run}a${n}`) });
    await delegate.create({ data: build(b.id, `${run}b${n}`) });
    n++;
  }
  return { a: { id: a.id, slug: a.slug }, b: { id: b.id, slug: b.slug } };
}
