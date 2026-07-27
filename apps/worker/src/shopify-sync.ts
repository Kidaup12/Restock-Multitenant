import { UnrecoverableError, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { guessRoleFromName, prismaService, roleOfType, typeOfRole } from "@wezesha/db";
import { publishEvent } from "@wezesha/realtime";
import { tenantDayKey } from "@wezesha/pos";
import type { SyncJobData } from "@wezesha/queue";
import type { SendEmail } from "./email";
import { clearIncident, sendIncidentAlert } from "./incident";
import {
  ShopifyAuthError,
  bucketSalesByProductDay,
  computeWindowStart,
  createShopifyClient,
  decryptToken,
  ensureWebhookSubscriptions,
  fetchLocationsWithInventory,
  fetchOrdersSince,
  fetchProducts,
  numericCore,
  type ShopifyClient,
  type ShopifyLocationNode,
  type ShopifyOrderNode,
  type ShopifyProductNode,
} from "@wezesha/shopify";

/**
 * The real per-tenant Shopify sync: products → locations+inventory → orders,
 * each phase advancing its own IngestCursor so a crashed or rate-limited run
 * resumes where it stopped instead of restarting the whole pull.
 *
 * Writes go through prismaService WITH an explicit tenantId on every query —
 * the worker is a system path (no session, no request), which is exactly what
 * the BYPASSRLS client exists for. Product identity is the NUMERIC CORE of the
 * Shopify gid ("gid://shopify/Product/123" → "123"); the database only ever
 * stores cores, so bare-id/gid spelling mismatches cannot mint duplicates.
 */

const OVERLAP_HOURS = 6;
// First order pull reaches back a year — sales history is the forecast's fuel.
const FIRST_RUN_ORDER_LOOKBACK_DAYS = 365;
const SALES_CHUNK = 500;

/** The Shopify surface the sync touches, injectable for job tests. */
export interface ShopifySyncApi {
  ensureWebhooks(callbackUrl: string): Promise<void>;
  products(sinceIso: string | null): Promise<ShopifyProductNode[]>;
  locations(): Promise<ShopifyLocationNode[]>;
  orders(sinceIso: string): Promise<ShopifyOrderNode[]>;
}

export function realShopifySyncApi(client: ShopifyClient): ShopifySyncApi {
  return {
    ensureWebhooks: (callbackUrl) => ensureWebhookSubscriptions(client, callbackUrl),
    products: (sinceIso) => fetchProducts(client, sinceIso),
    locations: () => fetchLocationsWithInventory(client),
    orders: (sinceIso) => fetchOrdersSince(client, sinceIso),
  };
}

async function getCursor(tenantId: string, resource: string): Promise<Date | null> {
  const row = await prismaService.ingestCursor.findUnique({
    where: { tenantId_source_resource: { tenantId, source: "shopify", resource } },
    select: { cursor: true },
  });
  return row?.cursor ?? null;
}

async function setCursor(tenantId: string, resource: string, value: Date): Promise<void> {
  await prismaService.ingestCursor.upsert({
    where: { tenantId_source_resource: { tenantId, source: "shopify", resource } },
    create: { tenantId, source: "shopify", resource, cursor: value },
    update: { cursor: value },
  });
}

/** Upsert products keyed on (tenantId, core id). Cost only writes when Shopify
 *  supplies one AND the row isn't owner-pinned ("manual" costSource wins). */
async function syncProducts(tenantId: string, nodes: ShopifyProductNode[]): Promise<number> {
  if (nodes.length === 0) return 0;
  const existing = await prismaService.product.findMany({
    where: { tenantId, shopifyProductId: { not: null } },
    select: { shopifyProductId: true, costSource: true },
  });
  const costPinned = new Set(
    existing.filter((p) => p.costSource === "manual").map((p) => p.shopifyProductId as string)
  );

  let written = 0;
  for (const node of nodes) {
    // A gift card is issued on sale, not stocked: it has no unit cost, no
    // supplier and nothing to reorder, so letting it into the catalogue would
    // put "restock gift cards" on a buy list and skew the shop's product count.
    if (node.isGiftCard) continue;
    const core = numericCore(node.id);
    const firstVariant = node.variants?.[0];
    const price = firstVariant?.price ? Number.parseFloat(firstVariant.price) : 0;
    const costRaw = firstVariant?.inventoryItem?.unitCost?.amount;
    const costParsed = costRaw ? Number.parseFloat(costRaw) : NaN;
    const writeCost = Number.isFinite(costParsed) && !costPinned.has(core);

    // The variant is the identity now, not the product: siblings share
    // shopifyProductId, so it can no longer be the key. Every Shopify product
    // carries at least a default variant; one without is unidentifiable, so it
    // is left alone rather than written under a null key.
    const variantId = firstVariant?.id ? numericCore(firstVariant.id) : null;
    if (!variantId) continue;

    const common = {
      shopifyProductId: core,
      sku: firstVariant?.sku ?? "",
      title: node.title ?? "(untitled)",
      vendor: node.vendor ?? null,
      productType: node.productType ?? null,
      priceKes: Number.isFinite(price) ? price : 0,
      ...(writeCost ? { costKes: costParsed, costSource: "shopify" } : {}),
      imageUrl: node.featuredImage?.url ?? null,
      ...(node.createdAt ? { shopifyCreatedAt: new Date(node.createdAt) } : {}),
    };
    await prismaService.product.upsert({
      where: { tenantId_shopifyVariantId: { tenantId, shopifyVariantId: variantId } },
      create: { tenantId, shopifyVariantId: variantId, ...common },
      update: { ...common, lastSynced: new Date() },
    });
    written += 1;
  }
  return written;
}

/**
 * Upsert locations + per-location levels, then roll them up BY ROLE:
 *  - Sells locations' on_hand → Product.currentStock (sellable on-hand)
 *  - En-route locations' on_hand → Product.onOrder (never counted as on-hand)
 *  - Holds (warehouse) / Ignore contribute to neither (held for transfers /
 *    excluded); their raw on_hand is still stored per InventoryLevel.
 * Shopify "incoming" per level is stored on InventoryLevel.incoming.
 *
 * A location with no owner-confirmed role gets a name-guessed role stamped as
 * "assumed"; a "confirmed" role is never overwritten by the sync.
 */
async function syncLocationsAndInventory(
  tenantId: string,
  locations: ShopifyLocationNode[],
  productIdByCore: Map<string, string>
): Promise<{ locations: number; levels: number }> {
  let levels = 0;
  const sellsByProduct = new Map<string, number>();
  const enrouteByProduct = new Map<string, number>();
  const seenProducts = new Set<string>();

  for (const loc of locations) {
    const locCore = numericCore(loc.id);
    const existing = await prismaService.location.findUnique({
      where: { tenantId_shopifyLocationId: { tenantId, shopifyLocationId: locCore } },
      select: { roleStatus: true },
    });
    // Guess a role for new / still-assumed locations; never touch a confirmed one.
    const roleData =
      existing?.roleStatus === "confirmed"
        ? {}
        : { locationType: typeOfRole(guessRoleFromName(loc.name)), roleStatus: "assumed" };
    const row = await prismaService.location.upsert({
      where: { tenantId_shopifyLocationId: { tenantId, shopifyLocationId: locCore } },
      create: { tenantId, shopifyLocationId: locCore, name: loc.name ?? "(unnamed)", ...roleData },
      update: { name: loc.name ?? "(unnamed)", ...roleData },
      select: { id: true, locationType: true },
    });
    const role = roleOfType(row.locationType);

    for (const level of loc.inventoryLevels ?? []) {
      const productGid = level.item?.variant?.product?.id;
      if (!productGid) continue;
      const productId = productIdByCore.get(numericCore(productGid));
      if (!productId) continue; // product not ingested (draft/archived) — skip
      const onHand = level.quantities?.find((q) => q.name === "on_hand")?.quantity ?? 0;
      const incoming = level.quantities?.find((q) => q.name === "incoming")?.quantity ?? 0;
      await prismaService.inventoryLevel.upsert({
        where: { locationId_productId: { locationId: row.id, productId } },
        create: { tenantId, locationId: row.id, productId, onHand, incoming },
        update: { onHand, incoming },
      });
      seenProducts.add(productId);
      if (role === "sells") sellsByProduct.set(productId, (sellsByProduct.get(productId) ?? 0) + onHand);
      else if (role === "enroute")
        enrouteByProduct.set(productId, (enrouteByProduct.get(productId) ?? 0) + onHand);
      levels++;
    }
  }

  // Full-snapshot semantics: every product seen this sync gets both figures
  // rewritten (0 when it has no Sells / En-route stock), so stock that moved out
  // of a selling location drops out of sellable on-hand instead of lingering.
  for (const productId of seenProducts) {
    await prismaService.product.updateMany({
      where: { id: productId, tenantId },
      data: {
        currentStock: sellsByProduct.get(productId) ?? 0,
        onOrder: enrouteByProduct.get(productId) ?? 0,
      },
    });
  }
  return { locations: locations.length, levels };
}

/** Idempotent day-set sales writer: delete exactly the touched (product, day)
 *  pairs, then createMany — SET semantics, so overlap windows never double-count. */
async function syncOrders(
  tenantId: string,
  orders: ShopifyOrderNode[],
  productIdByCore: Map<string, string>,
  locationIdByCore: Map<string, string>
): Promise<number> {
  // The trading day is the tenant's, not UTC — the same rule, and the same
  // function, the till feed uses, so one day of trade never lands on two dates
  // depending on which channel it came through.
  const tenant = await prismaService.tenant.findUnique({
    where: { id: tenantId },
    select: { timezone: true },
  });
  if (!tenant) return 0;
  const buckets = [
    ...bucketSalesByProductDay(
      orders,
      productIdByCore,
      (d) => tenantDayKey(tenant.timezone, d),
      locationIdByCore
    ).values(),
  ];
  if (buckets.length === 0) return 0;

  const rows = buckets.map((b) => ({
    tenantId,
    productId: b.productId,
    date: new Date(`${b.dateKey}T00:00:00.000Z`),
    quantity: b.quantity,
    revenueKes: b.revenue,
    channel: "shopify" as const,
    locationId: b.locationId,
  }));

  for (let i = 0; i < rows.length; i += SALES_CHUNK) {
    const chunk = rows.slice(i, i + SALES_CHUNK);
    await prismaService.salesHistory.deleteMany({
      where: {
        tenantId,
        channel: "shopify",
        OR: chunk.map((r) => ({ productId: r.productId, date: r.date })),
      },
    });
    await prismaService.salesHistory.createMany({ data: chunk });
  }
  return rows.length;
}

async function loadProductIdByCore(tenantId: string): Promise<Map<string, string>> {
  const products = await prismaService.product.findMany({
    where: { tenantId, shopifyProductId: { not: null } },
    select: { id: true, shopifyProductId: true },
  });
  return new Map(products.map((p) => [p.shopifyProductId as string, p.id]));
}

async function loadLocationIdByCore(tenantId: string): Promise<Map<string, string>> {
  const rows = await prismaService.location.findMany({
    where: { tenantId, shopifyLocationId: { not: null } },
    select: { id: true, shopifyLocationId: true },
  });
  return new Map(rows.map((l) => [l.shopifyLocationId as string, l.id]));
}

export interface ShopifySyncOptions {
  publisher: Redis;
  /** Injectable Shopify surface for tests; defaults to the real API client. */
  makeApi?: (shopDomain: string, accessToken: string) => ShopifySyncApi;
  /** Public app origin for webhook registration; falls back to env, then skips. */
  appUrl?: string;
}

const PHASES = ["products", "inventory", "orders"] as const;

export function createShopifySyncProcessor(options: ShopifySyncOptions) {
  const makeApi =
    options.makeApi ??
    ((shopDomain: string, accessToken: string) =>
      realShopifySyncApi(createShopifyClient({ shopDomain, accessToken })));

  return async (job: Job<SyncJobData>): Promise<void> => {
    const { tenantId } = job.data;
    const connection = await prismaService.shopifyConnection.findUnique({ where: { tenantId } });
    if (!connection || connection.uninstalledAt) {
      // No live store: retrying cannot help — fail the job for good.
      throw new UnrecoverableError(`tenant ${tenantId} has no live Shopify connection`);
    }

    let api: ShopifySyncApi;
    try {
      api = makeApi(connection.shopDomain, decryptToken(connection.accessToken));
    } catch (err) {
      throw new UnrecoverableError(`stored Shopify token unusable: ${(err as Error).message}`);
    }

    try {
      const appUrl = options.appUrl ?? process.env.SHOPIFY_APP_URL;
      if (appUrl) {
        await api.ensureWebhooks(`${appUrl.replace(/\/$/, "")}/api/webhooks/shopify`);
      }

      const runStart = new Date();
      const progress = async (phase: (typeof PHASES)[number]) => {
        await publishEvent(options.publisher, {
          type: "sync.progress",
          data: {
            tenantId,
            source: "shopify",
            phase,
            done: PHASES.indexOf(phase) + 1,
            total: PHASES.length,
          },
        });
      };

      // ── Products (delta since cursor; full catalog on first run) ────────────
      const productsCursor = await getCursor(tenantId, "products");
      const productsSince = productsCursor
        ? computeWindowStart(productsCursor, runStart, {
            overlapHours: OVERLAP_HOURS,
            firstRunLookbackDays: 1,
          }).toISOString()
        : null;
      await syncProducts(tenantId, await api.products(productsSince));
      await setCursor(tenantId, "products", runStart);
      await progress("products");

      // ── Locations + inventory (full refresh — no cheap delta) ───────────────
      const productIdByCore = await loadProductIdByCore(tenantId);
      await syncLocationsAndInventory(tenantId, await api.locations(), productIdByCore);
      await setCursor(tenantId, "inventory", runStart);
      await progress("inventory");

      // ── Orders → SalesHistory day sets ──────────────────────────────────────
      const ordersCursor = await getCursor(tenantId, "orders");
      const ordersSince = computeWindowStart(ordersCursor, runStart, {
        overlapHours: OVERLAP_HOURS,
        firstRunLookbackDays: FIRST_RUN_ORDER_LOOKBACK_DAYS,
      });
      // Locations exist now (inventory phase ran) — map them for fulfilment
      // attribution of online sales.
      const locationIdByCore = await loadLocationIdByCore(tenantId);
      await syncOrders(tenantId, await api.orders(ordersSince.toISOString()), productIdByCore, locationIdByCore);
      await setCursor(tenantId, "orders", runStart);
      await progress("orders");

      await publishEvent(options.publisher, {
        type: "sync.done",
        data: { tenantId, source: "shopify", ok: true },
      });
      // Recovery re-arms the reconnect alert (see incident.ts).
      await clearIncident(options.publisher, tenantId, "shopify");
    } catch (err) {
      if (err instanceof ShopifyAuthError) {
        // Token revoked / app uninstalled: retrying is pointless.
        throw new UnrecoverableError(err.message);
      }
      throw err;
    }
  };
}

/**
 * Final-failure hook (wired to the worker's `failed` event): when a sync is out
 * of retries — or failed unrecoverably — persist a Notification for the bell,
 * email the tenant's alert contact (once per incident — see incident.ts), and
 * tell live clients the sync ended. Retry-pending failures stay silent.
 */
export async function handleSyncFailure(
  job: Job<SyncJobData> | undefined,
  err: Error,
  publisher: Redis,
  deps: { send?: SendEmail } = {}
): Promise<void> {
  if (!job || job.data.source !== "shopify") return;
  const isFinal = err.name === "UnrecoverableError" || job.attemptsMade >= (job.opts.attempts ?? 1);
  if (!isFinal) return;

  const { tenantId } = job.data;
  // The processor wraps ShopifyAuthError in UnrecoverableError, so match on the
  // message too — the class identity does not survive the wrap.
  const reconnect =
    err instanceof ShopifyAuthError ||
    /auth failed|token revoked|no live Shopify connection|token unusable/.test(err.message);
  try {
    await prismaService.notification.create({
      data: {
        tenantId,
        kind: reconnect ? "shopify_reconnect" : "sync_failed",
        title: reconnect ? "Shopify connection needs attention" : "Shopify sync failed",
        body: reconnect
          ? "The store's access token no longer works. Please reconnect the store under Settings → Connections."
          : `The last sync did not finish: ${err.message.slice(0, 300)}`,
      },
    });
    await publishEvent(publisher, {
      type: "notification.new",
      data: { tenantId, kind: reconnect ? "shopify_reconnect" : "sync_failed", title: "Shopify sync failed" },
    });
  } catch (persistErr) {
    // A missing tenant (e.g. smoke fixtures) must not crash the worker loop.
    console.error(`worker: could not persist sync-failure notification for ${tenantId}`, persistErr);
  }
  try {
    await sendIncidentAlert({
      redis: publisher,
      tenantId,
      source: "shopify",
      reason: err.message.slice(0, 300),
      send: deps.send,
    });
  } catch (mailErr) {
    console.error(`worker: could not send sync-failure alert for ${tenantId}`, mailErr);
  }
  await publishEvent(publisher, {
    type: "sync.done",
    data: { tenantId, source: "shopify", ok: false },
  }).catch(() => {});
}
