import { UnrecoverableError, type Job } from "bullmq";
import type { Redis } from "ioredis";
import {
  guessRoleFromName,
  isProductStatus,
  NOT_SELLING_STATUSES,
  prismaService,
  roleOfType,
  typeOfRole,
} from "@wezesha/db";
import { publishEvent } from "@wezesha/realtime";
import { tenantDayKey } from "@wezesha/pos";
import type { SyncJobData } from "@wezesha/queue";
import type { SendEmail } from "./email";
import { clearIncident, sendIncidentAlert } from "./incident";
import { SyncRunReporter } from "./sync-run";
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
  fetchShopSettings,
  numericCore,
  type ShopifyClient,
  type ShopifyLocationNode,
  type ShopifyOrderNode,
  type ShopifyProductNode,
  type ShopSettings,
} from "@wezesha/shopify";
import type { ProductStatus } from "@wezesha/db";

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

/** What the products phase wrote, plus what the shop should be told about it. */
export type ProductSyncResult = {
  written: number;
  failed: number;
  /** Variants that did not exist in the catalogue before this run. */
  created: number;
  /** Of those, how many arrived with no unit cost — each one is held off the
   *  buy list until somebody fills it in. */
  createdWithoutCost: number;
  /** SKUs this run created that now sit on more than one product. */
  duplicateSkus: number;
};

const OVERLAP_HOURS = 6;
// First order pull reaches back a year — sales history is the forecast's fuel.
const FIRST_RUN_ORDER_LOOKBACK_DAYS = 365;
const SALES_CHUNK = 500;

/** Reports how far through a phase the writer is. The reporter throttles, so a
 *  writer may call this per record without thinking about publish volume. */
type ProgressFn = (done: number, total: number) => Promise<void> | void;

/** The Shopify surface the sync touches, injectable for job tests. */
export interface ShopifySyncApi {
  ensureWebhooks(callbackUrl: string): Promise<void>;
  shopSettings(): Promise<ShopSettings>;
  products(sinceIso: string | null): Promise<ShopifyProductNode[]>;
  locations(): Promise<ShopifyLocationNode[]>;
  orders(sinceIso: string): Promise<ShopifyOrderNode[]>;
}

export function realShopifySyncApi(client: ShopifyClient): ShopifySyncApi {
  return {
    ensureWebhooks: (callbackUrl) => ensureWebhookSubscriptions(client, callbackUrl),
    shopSettings: () => fetchShopSettings(client),
    products: (sinceIso) => fetchProducts(client, sinceIso),
    locations: () => fetchLocationsWithInventory(client),
    orders: (sinceIso) => fetchOrdersSince(client, sinceIso),
  };
}

/** Adopt the store's own currency. The store is the authority — the app used to
 *  render every figure in shillings whatever the shop actually traded in. Read
 *  each sync, not just at install, so a connected store fixes itself. */
async function syncShopCurrency(tenantId: string, api: ShopifySyncApi): Promise<void> {
  try {
    const { currencyCode } = await api.shopSettings();
    if (!currencyCode) return;
    await prismaService.tenant.updateMany({
      where: { id: tenantId, currency: { not: currencyCode } },
      data: { currency: currencyCode },
    });
  } catch (err) {
    // Never fail a sync over a display setting.
    console.error(`worker: could not read shop settings for ${tenantId}`, err);
  }
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

/** Longest per-SKU failure text kept on the row — enough to name the cause,
 *  short enough that a bad batch can't bloat the catalogue table. */
const SYNC_ERROR_MAX = 300;

/** Shopify's ProductStatus enum → the column the buy-list predicate reads.
 *  Anything unrecognised reads as "active": writing an unknown string there
 *  would hold a live SKU off every list with no way for the owner to see why. */
function productStatusOf(raw: string | undefined): ProductStatus {
  const status = (raw ?? "").toLowerCase();
  return isProductStatus(status) ? status : "active";
}

/** Shopify titles the only variant of an option-less product "Default Title".
 *  That is API plumbing, not something a shopper-facing row should read. */
function variantTitleOf(raw: string | null | undefined): string | null {
  const title = raw?.trim();
  return !title || title === "Default Title" ? null : title;
}

/**
 * Upsert ONE ROW PER VARIANT, keyed on (tenantId, variant core id) — a six-shade
 * foundation is six rows, because the SKU is what the shop counts and orders.
 * Product-level fields are copied onto every sibling; price, cost, SKU and the
 * variant title come from that variant. Cost only writes when Shopify supplies
 * one AND the row isn't owner-pinned ("manual" costSource wins). Price writes
 * only when the store supplies one — an absent price is not a price of zero, and
 * writing the zero would wipe whatever the row already carries.
 *
 * A row the owner pinned with "keep active" (activeOverride) keeps its stored
 * shopifyStatus when the store reports draft or archived. The buy-list predicate
 * reads shopifyStatus as well as active, so without that the store's status
 * would undo the pin on the very next pull. The pin is a FLOOR, not a freeze: a
 * store status that still sells writes through as normal.
 *
 * On a FULL sync (no incremental cursor) any Shopify-sourced row not seen in the
 * pull is stamped missingFromShopifyAt — it is gone from the store. That must
 * never run on an incremental sync, which legitimately sees only the products
 * that changed recently and would otherwise mark the whole catalogue missing.
 */
async function syncProducts(
  tenantId: string,
  nodes: ShopifyProductNode[],
  options: { fullSync: boolean; onProgress?: ProgressFn }
): Promise<ProductSyncResult> {
  // An empty pull is never evidence that the store is empty — a rate-limited or
  // half-answered run looks exactly the same, so nothing is marked missing.
  if (nodes.length === 0) {
    return { written: 0, failed: 0, created: 0, createdWithoutCost: 0, duplicateSkus: 0 };
  }
  await options.onProgress?.(0, nodes.length);
  const existing = await prismaService.product.findMany({
    where: { tenantId, shopifyVariantId: { not: null } },
    select: { shopifyVariantId: true, costSource: true, activeOverride: true },
  });
  const costPinned = new Set(
    existing.filter((p) => p.costSource === "manual").map((p) => p.shopifyVariantId as string)
  );
  const keptActive = new Set(
    existing.filter((p) => p.activeOverride).map((p) => p.shopifyVariantId as string)
  );

  // Which variants the catalogue already knew. The upsert cannot tell a create
  // from an update after the fact, and this row set is already loaded for the
  // cost/active pins — so the arrival of a new product costs no extra query.
  const known = new Set(existing.map((p) => p.shopifyVariantId as string));

  const seen: string[] = [];
  const created: string[] = [];
  let createdWithoutCost = 0;
  let written = 0;
  let failed = 0;
  let processed = 0;
  for (const node of nodes) {
    await options.onProgress?.(++processed, nodes.length);
    // A gift card is issued on sale, not stocked: it has no unit cost, no
    // supplier and nothing to reorder, so letting it into the catalogue would
    // put "restock gift cards" on a buy list and skew the shop's product count.
    if (node.isGiftCard) continue;
    const shared = {
      shopifyProductId: numericCore(node.id),
      title: node.title ?? "(untitled)",
      vendor: node.vendor ?? null,
      productType: node.productType ?? null,
      imageUrl: node.featuredImage?.url ?? null,
      publishedAt: node.publishedAt ? new Date(node.publishedAt) : null,
      ...(node.createdAt ? { shopifyCreatedAt: new Date(node.createdAt) } : {}),
    };
    // Status is per-variant here only because the owner's keep-active pin is:
    // the store carries one status for the whole product, but the pin is on the
    // SKU the shop decided to go on ordering.
    const shopifyStatus = productStatusOf(node.status);
    const stopsSelling = NOT_SELLING_STATUSES.includes(shopifyStatus);

    for (const variant of node.variants ?? []) {
      // Every Shopify product carries at least a default variant; one without an
      // id is unidentifiable, so it is left alone rather than written under a
      // null key.
      const variantId = variant.id ? numericCore(variant.id) : null;
      if (!variantId) continue;
      seen.push(variantId);
      try {
        const price = variant.price ? Number.parseFloat(variant.price) : NaN;
        const costRaw = variant.inventoryItem?.unitCost?.amount;
        const costParsed = costRaw ? Number.parseFloat(costRaw) : NaN;
        const writeCost = Number.isFinite(costParsed) && !costPinned.has(variantId);
        // The owner's "keep active" pin blocks exactly the status that would take
        // the SKU off the buy list; anything else the store says still writes.
        const holdStatus = stopsSelling && keptActive.has(variantId);
        const common = {
          ...shared,
          sku: variant.sku ?? "",
          variantTitle: variantTitleOf(variant.title),
          ...(holdStatus ? {} : { shopifyStatus }),
          ...(Number.isFinite(price) ? { priceKes: price } : {}),
          ...(writeCost ? { costKes: costParsed, costSource: "shopify" } : {}),
          // The store just handed it to us, so it is neither missing nor failing.
          missingFromShopifyAt: null,
          syncError: null,
          syncErrorAt: null,
        };
        await prismaService.product.upsert({
          where: { tenantId_shopifyVariantId: { tenantId, shopifyVariantId: variantId } },
          create: { tenantId, shopifyVariantId: variantId, ...common },
          update: { ...common, lastSynced: new Date() },
        });
        written += 1;
        if (!known.has(variantId)) {
          created.push(variantId);
          // A product the shop cannot buy a decision from: with no unit cost it
          // is held off the buy list entirely, and nothing on screen says so
          // until someone goes looking for it.
          if (!Number.isFinite(costParsed)) createdWithoutCost += 1;
        }
      } catch (err) {
        // One malformed record used to abort the whole products phase and cost
        // the shop every SKU behind it. Pin the failure to the row instead —
        // the catalogue shows it, and the count below still reaches the operator.
        failed += 1;
        await prismaService.product
          .updateMany({
            where: { tenantId, shopifyVariantId: variantId },
            data: {
              syncError: (err as Error).message.slice(0, SYNC_ERROR_MAX),
              syncErrorAt: new Date(),
            },
          })
          .catch(() => {});
      }
    }
  }

  if (failed > 0) {
    // Every SKU failing is not a per-record blip — fail the job so the operator
    // gets the notification + alert instead of a silently empty catalogue.
    if (written === 0) throw new Error(`Shopify products sync failed for all ${failed} variants`);
    console.error(`worker: ${failed} of ${failed + written} Shopify variants failed to sync for ${tenantId}`);
  }

  if (options.fullSync) {
    await prismaService.product.updateMany({
      where: {
        tenantId,
        source: "shopify",
        shopifyVariantId: { not: null, notIn: seen },
        missingFromShopifyAt: null,
      },
      data: { missingFromShopifyAt: new Date() },
    });
  }

  // A duplicate is a SKU that now sits on more than one product. Shopify's
  // "Duplicate product" is the usual way one appears, and the shop finds out
  // when two rows compete on the same buy list. Only asked about the SKUs this
  // run created, so the query stays proportional to what changed.
  const newSkus = created.length
    ? (
        await prismaService.product.findMany({
          where: { tenantId, shopifyVariantId: { in: created }, sku: { not: "" } },
          select: { sku: true },
        })
      ).map((p) => p.sku)
    : [];
  const duplicateSkus = newSkus.length
    ? (
        await prismaService.product.groupBy({
          by: ["sku"],
          where: { tenantId, sku: { in: newSkus } },
          _count: { _all: true },
        })
      ).filter((g) => g._count._all > 1).length
    : 0;

  return {
    written,
    failed,
    created: created.length,
    createdWithoutCost,
    duplicateSkus,
  };
}

/**
 * Upsert locations + per-location levels, then roll them up BY ROLE:
 *  - Sells locations' on_hand → Product.currentStock (sellable on-hand)
 *  - En-route locations' on_hand → Product.onOrder (never counted as on-hand)
 *  - Holds (warehouse) / Ignore contribute to neither (held for transfers /
 *    excluded); their raw on_hand is still stored per InventoryLevel.
 *
 * Shopify's own "incoming" per level is stored on InventoryLevel.incoming AND
 * summed into Product.onOrder across every location bar Ignore. That is where a
 * purchase order or a transfer actually shows up — against the destination,
 * which for most shops is a plain selling branch — so a rollup keyed only on the
 * En-route role reported nothing incoming for them, and the buy list went on
 * recommending stock that was already on its way.
 *
 * A location with no owner-confirmed role gets a name-guessed role stamped as
 * "assumed"; a "confirmed" role is never overwritten by the sync.
 */
async function syncLocationsAndInventory(
  tenantId: string,
  locations: ShopifyLocationNode[],
  productIdByVariantCore: Map<string, string>,
  onProgress?: ProgressFn
): Promise<{ locations: number; levels: number }> {
  let levels = 0;
  let processed = 0;
  const sellsByProduct = new Map<string, number>();
  const enrouteByProduct = new Map<string, number>();
  const incomingByProduct = new Map<string, number>();
  const seenProducts = new Set<string>();

  await onProgress?.(0, locations.length);
  for (const loc of locations) {
    await onProgress?.(++processed, locations.length);
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
      // Stock is held against the VARIANT. Mapping a level by its parent product
      // piled every sibling shade's on-hand onto one row, while that row's price
      // and SKU came from a different shade.
      const variantGid = level.item?.variant?.id;
      if (!variantGid) continue;
      const productId = productIdByVariantCore.get(numericCore(variantGid));
      if (!productId) continue; // variant not in the catalogue (gift card) — skip
      const onHand = level.quantities?.find((q) => q.name === "on_hand")?.quantity ?? 0;
      const incoming = level.quantities?.find((q) => q.name === "incoming")?.quantity ?? 0;
      // Shopify sends "available" on every level (resources.ts asks for it). It
      // is on_hand minus whatever is committed to unfulfilled orders — the only
      // one of the two that answers "how much can we actually sell". Absent only
      // in a fixture that forgot it, and null is the honest record of that.
      const available = level.quantities?.find((q) => q.name === "available")?.quantity ?? null;
      // eslint-disable-next-line tenant-safety/require-tenant-scope -- the unique key is (locationId, productId) and both ids were resolved inside this tenant's sync, so the lookup cannot reach another tenant's row; the created row carries tenantId.
      await prismaService.inventoryLevel.upsert({
        where: { locationId_productId: { locationId: row.id, productId } },
        create: { tenantId, locationId: row.id, productId, onHand, available, incoming },
        update: { onHand, available, incoming },
      });
      seenProducts.add(productId);
      if (role === "sells") sellsByProduct.set(productId, (sellsByProduct.get(productId) ?? 0) + onHand);
      else if (role === "enroute")
        enrouteByProduct.set(productId, (enrouteByProduct.get(productId) ?? 0) + onHand);
      // Shopify's own in-transit number, counted wherever it lands. A purchase
      // order or transfer shows as `incoming` at its DESTINATION — an ordinary
      // selling branch — so keying this off the En-route role alone discarded it
      // for every shop that does not model transit as a location.
      if (role !== "ignore")
        incomingByProduct.set(productId, (incomingByProduct.get(productId) ?? 0) + incoming);
      levels++;
    }
  }

  // Full-snapshot semantics: every product seen this sync gets both figures
  // rewritten (0 when it has no Sells / En-route stock), so stock that moved out
  // of a selling location drops out of sellable on-hand instead of lingering —
  // and stock that has arrived drops out of on-order the same way.
  for (const productId of seenProducts) {
    await prismaService.product.updateMany({
      where: { id: productId, tenantId },
      data: {
        currentStock: sellsByProduct.get(productId) ?? 0,
        // Both conventions, because a shop uses one or the other: Shopify's
        // `incoming`, and stock parked at a location the owner typed En route.
        // A shop doing both would briefly double-count a transfer into that
        // location, which resolves itself the moment the stock is received.
        onOrder: (enrouteByProduct.get(productId) ?? 0) + (incomingByProduct.get(productId) ?? 0),
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
  locationIdByCore: Map<string, string>,
  productIdByVariantCore: Map<string, string>,
  onProgress?: ProgressFn
): Promise<number> {
  // The trading day is the tenant's, not UTC — the same rule, and the same
  // function, the till feed uses, so one day of trade never lands on two dates
  // depending on which channel it came through.
  // eslint-disable-next-line tenant-safety/require-tenant-scope -- reads one tenant by the id the job already carries; the worker has no session, so there is no resolver to route through.
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
      locationIdByCore,
      productIdByVariantCore
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

  // The denominator legitimately changes here: the phase started counting orders
  // fetched, and finishes counting the day-sets they bucket into.
  await onProgress?.(0, rows.length);
  for (let i = 0; i < rows.length; i += SALES_CHUNK) {
    const chunk = rows.slice(i, i + SALES_CHUNK);
    await onProgress?.(i + chunk.length, rows.length);
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

/** Shopify product core → local product id. Sibling variants share a product
 *  core, so this map can only answer "some row of that product" — it is the
 *  fallback for order lines that carry no variant, never the inventory key. */
async function loadProductIdByCore(tenantId: string): Promise<Map<string, string>> {
  const products = await prismaService.product.findMany({
    where: { tenantId, shopifyProductId: { not: null } },
    select: { id: true, shopifyProductId: true },
  });
  return new Map(products.map((p) => [p.shopifyProductId as string, p.id]));
}

/** Shopify variant core → local product id: the one-to-one map, since the
 *  catalogue is one row per variant. */
async function loadProductIdByVariantCore(tenantId: string): Promise<Map<string, string>> {
  const products = await prismaService.product.findMany({
    where: { tenantId, shopifyVariantId: { not: null } },
    select: { id: true, shopifyVariantId: true },
  });
  return new Map(products.map((p) => [p.shopifyVariantId as string, p.id]));
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

    // One row per attempt, opened before any work: the Connections screen reads
    // it, so a run must be visible from the moment it starts, not once its first
    // phase finishes.
    const run = await SyncRunReporter.open({
      publisher: options.publisher,
      tenantId,
      source: "shopify",
      phases: PHASES,
      attempt: job.attemptsMade + 1,
    });

    try {
      const appUrl = options.appUrl ?? process.env.SHOPIFY_APP_URL;
      if (appUrl) {
        await api.ensureWebhooks(`${appUrl.replace(/\/$/, "")}/api/webhooks/shopify`);
      }

      const runStart = new Date();
      await syncShopCurrency(tenantId, api);

      // ── Products (delta since cursor; full catalog on first run) ────────────
      // The phase opens before the fetch, which is the longest silent stretch of
      // the whole sync and cannot report a total until it returns.
      await run.phaseStart("products");
      const productsCursor = await getCursor(tenantId, "products");
      const productsSince = productsCursor
        ? computeWindowStart(productsCursor, runStart, {
            overlapHours: OVERLAP_HOURS,
            firstRunLookbackDays: 1,
          }).toISOString()
        : null;
      // No cursor means a FULL catalogue pull, which is the only run that can
      // tell a SKU deleted in the store from one that simply didn't change.
      const products = await syncProducts(tenantId, await api.products(productsSince), {
        fullSync: productsSince === null,
        onProgress: (done, total) => run.tick(done, total),
      });
      await setCursor(tenantId, "products", runStart);
      await run.phaseEnd("products", products);
      await notifyCatalogueChanges(tenantId, products, options.publisher);

      // ── Locations + inventory (full refresh — no cheap delta) ───────────────
      await run.phaseStart("inventory");
      const productIdByVariantCore = await loadProductIdByVariantCore(tenantId);
      const inventory = await syncLocationsAndInventory(
        tenantId,
        await api.locations(),
        productIdByVariantCore,
        (done, total) => run.tick(done, total)
      );
      await setCursor(tenantId, "inventory", runStart);
      await run.phaseEnd("inventory", inventory);

      // ── Orders → SalesHistory day sets ──────────────────────────────────────
      await run.phaseStart("orders");
      const ordersCursor = await getCursor(tenantId, "orders");
      const ordersSince = computeWindowStart(ordersCursor, runStart, {
        overlapHours: OVERLAP_HOURS,
        firstRunLookbackDays: FIRST_RUN_ORDER_LOOKBACK_DAYS,
      });
      // Locations exist now (inventory phase ran) — map them for fulfilment
      // attribution of online sales.
      const locationIdByCore = await loadLocationIdByCore(tenantId);
      const productIdByCore = await loadProductIdByCore(tenantId);
      const salesDays = await syncOrders(
        tenantId,
        await api.orders(ordersSince.toISOString()),
        productIdByCore,
        locationIdByCore,
        productIdByVariantCore,
        (done, total) => run.tick(done, total)
      );
      await setCursor(tenantId, "orders", runStart);
      await run.phaseEnd("orders", { salesDays });

      await run.ok();
      // Recovery re-arms the reconnect alert (see incident.ts)...
      await clearIncident(options.publisher, tenantId, "shopify");
      // ...and lets the scheduler pick this store back up.
      await clearAuthFailureState(tenantId);
    } catch (err) {
      // Close the row on every exit, so a retry opens a fresh one and no attempt
      // is left reading as "running" for ever.
      await run.fail(err);
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
/** How long a catalogue notice suppresses an identical one. A sync runs every
 *  15 minutes; without this the bell would be unusable inside a day. */
const CATALOGUE_NOTICE_DEDUP_MS = 12 * 60 * 60 * 1000;

/** How long a sync-failure notice suppresses an identical one. Same window as the
 *  catalogue notice, and for the same reason: a condition that persists is worth
 *  re-raising twice a day, not four times an hour. */
const SYNC_FAILURE_NOTICE_DEDUP_MS = 12 * 60 * 60 * 1000;

/** Consecutive auth failures before the scheduler stops trying a store. Three
 *  rather than one: a 403 immediately after an install can be scope propagation
 *  or a Shopify-side blip, and pausing a healthy shop on a single bad answer
 *  costs more than three quarters of an hour of pointless retries. */
export const AUTH_FAILURES_BEFORE_PAUSE = 3;

/** Clear the auth-failure state after any successful sync — the token works, so
 *  whatever the counter was mid-way to is no longer true. Kept beside
 *  clearIncident: both are "this store recovered" signals and drift apart if
 *  they live in different places. */
export async function clearAuthFailureState(tenantId: string): Promise<void> {
  await prismaService.shopifyConnection.updateMany({
    where: { tenantId },
    data: { authFailureCount: 0, syncPausedAt: null, lastAuthError: null, lastAuthErrorAt: null },
  });
}

/**
 * Count an auth failure and pause the store once it has failed enough times in
 * a row. Returns true on the transition into paused, so the caller can say so
 * once rather than on every subsequent tick.
 */
async function recordAuthFailure(tenantId: string, message: string): Promise<boolean> {
  const connection = await prismaService.shopifyConnection.findUnique({
    where: { tenantId },
    select: { authFailureCount: true, syncPausedAt: true, uninstalledAt: true },
  });
  if (!connection || connection.syncPausedAt) return false;

  const count = connection.authFailureCount + 1;
  const pausing = count >= AUTH_FAILURES_BEFORE_PAUSE;
  await prismaService.shopifyConnection.update({
    where: { tenantId },
    data: {
      authFailureCount: count,
      lastAuthError: message.slice(0, 300),
      lastAuthErrorAt: new Date(),
      ...(pausing ? { syncPausedAt: new Date() } : {}),
    },
  });
  if (pausing && !connection.uninstalledAt) {
    // The store still reads as installed while refusing every request, so no
    // app/uninstalled webhook arrived. Either it never landed or the token was
    // revoked without an uninstall — worth knowing which, next time this happens.
    console.warn(
      `worker: pausing Shopify syncs for ${tenantId} after ${count} auth failures; connection still marked installed`
    );
  }
  return pausing;
}

/** The sentence a shop actually needs: what arrived, and what about it needs a
 *  human. Empty when the run changed nothing worth interrupting anyone for. */
export function catalogueNoticeTitle(result: ProductSyncResult): string | null {
  const parts: string[] = [];
  if (result.created > 0) {
    parts.push(`${result.created} new ${result.created === 1 ? "product" : "products"}`);
  }
  if (result.createdWithoutCost > 0) {
    parts.push(`${result.createdWithoutCost} with no cost`);
  }
  if (result.duplicateSkus > 0) {
    parts.push(`${result.duplicateSkus} duplicate ${result.duplicateSkus === 1 ? "SKU" : "SKUs"}`);
  }
  return parts.length > 0 ? `Catalogue: ${parts.join(", ")}` : null;
}

/**
 * Tell the shop what a sync brought in.
 *
 * Only the things that need a decision: a product that arrived with no cost is
 * held off the buy list until someone fills it in, and a duplicated SKU puts two
 * rows in competition on it. Both were already visible as filters on the Stock
 * screen, which is no use to anyone who does not know to go looking.
 *
 * Deduped on the exact title within a window, the same shape the sales-gap cron
 * uses — a repeated run that finds the same thing says nothing twice.
 */
async function notifyCatalogueChanges(
  tenantId: string,
  result: ProductSyncResult,
  publisher: Redis
): Promise<void> {
  const title = catalogueNoticeTitle(result);
  if (!title) return;

  try {
    const since = new Date(Date.now() - CATALOGUE_NOTICE_DEDUP_MS);
    const prior = await prismaService.notification.findFirst({
      where: { tenantId, kind: "catalogue_review", title, createdAt: { gte: since } },
      select: { id: true },
    });
    if (prior) return;

    await prismaService.notification.create({
      data: {
        tenantId,
        kind: "catalogue_review",
        title,
        body: "Check these under Stock — products without a cost stay off the buy list until one is set.",
      },
    });
    await publishEvent(publisher, {
      type: "notification.new",
      data: { tenantId, kind: "catalogue_review", title },
    }).catch(() => {});
  } catch (err) {
    // A catalogue notice is never worth failing a sync over.
    console.error(`worker: could not raise catalogue notice for ${tenantId}`, err);
  }
}

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
  // Counting happens before the notification so the pause can change what it says.
  const paused = reconnect ? await recordAuthFailure(tenantId, err.message).catch(() => false) : false;

  const kind = reconnect ? "shopify_reconnect" : "sync_failed";
  const title = paused
    ? "Shopify syncs are paused"
    : reconnect
      ? "Shopify connection needs attention"
      : "Shopify sync failed";
  try {
    // A revoked token fails every tick, and the tick is every 15 minutes — without
    // a window the bell fills with the same sentence hundreds of times while the
    // shop's actual problem stays exactly as unresolved as it was. The incident
    // email has its own one-shot latch (incident.ts); this feed needs the opposite,
    // something that resurfaces periodically, because it is what a human acts on.
    const since = new Date(Date.now() - SYNC_FAILURE_NOTICE_DEDUP_MS);
    const prior = await prismaService.notification.findFirst({
      where: { tenantId, kind, title, createdAt: { gte: since } },
      select: { id: true },
    });
    // Suppress the bell entry only — the incident email below keeps its own latch,
    // and skipping it here would tie two independent recovery signals together.
    if (!prior) {
      await prismaService.notification.create({
        data: {
          tenantId,
          kind,
          title,
          body: paused
            ? "Automatic syncs have stopped because the store's access token keeps being refused. Reconnect the store under Settings → Connections to resume."
            : reconnect
              ? "The store's access token no longer works. Please reconnect the store under Settings → Connections."
              : `The last sync did not finish: ${err.message.slice(0, 300)}`,
        },
      });
      await publishEvent(publisher, {
        type: "notification.new",
        data: { tenantId, kind, title },
      });
    }
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
