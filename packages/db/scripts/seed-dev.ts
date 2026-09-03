import "dotenv/config";
import { pathToFileURL } from "node:url";
import { hashPassword } from "better-auth/crypto";
import { prismaService } from "../src/client";

/**
 * Dev seed: one demo tenant ("amara-beauty") with a signable owner, a ~30-SKU
 * beauty catalogue, two locations with inventory, and 90 days of daily sales
 * history shaped so every screen state shows up — fast movers, slow movers,
 * stockout gaps, dead stock, and an overstocked SKU.
 *
 * The tenant sits on the Growth plan. Insights, the budget planner and supplier
 * PO-email are all Growth-tier features, so on the entry tier a demo of those
 * screens shows an upgrade wall instead of the feature.
 *
 * Idempotent: the tenant is deleted and rebuilt each run (cascade wipes all
 * child rows); the user is upserted by email so existing sessions survive a
 * re-seed. Writes go through the service client — this is an offline script,
 * the documented use-case for the BYPASSRLS connection.
 *
 * The password is stored by hashing directly with better-auth's own scrypt
 * (`hashPassword` from better-auth/crypto) into a `credential` Account row —
 * the exact hash `verifyPassword` checks at sign-in, without needing the web
 * app booted mid-seed. better-auth resolves from the workspace root install.
 *
 * Run from packages/db (dotenv reads ./.env):  npx tsx scripts/seed-dev.ts
 */

export const DEV_TENANT_SLUG = "amara-beauty";
export const DEV_TENANT_NAME = "Amara Beauty";
export const DEV_USER_EMAIL = "owner@wezesha.test";
export const DEV_USER_PASSWORD = "Owner12345!";
// One user per role so QA can test access levels (money-blind is role-based):
// admin sees costs + manages; member (staff) never sees cost or profit.
export const DEV_ADMIN_EMAIL = "admin@wezesha.test";
export const DEV_ADMIN_PASSWORD = "Admin12345!";
export const DEV_MEMBER_EMAIL = "staff@wezesha.test";
export const DEV_MEMBER_PASSWORD = "Staff12345!";

const DAYS = 90;

// Deterministic RNG (mulberry32) — same seed, same catalogue, every run.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** UTC midnight `daysAgo` days before today. */
function utcDay(daysAgo: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo));
}

/**
 * When during its day a sale happened.
 *
 * A real feed stamps sales through trading hours, so the newest COMPLETED day's
 * last sale is an evening one. Stamping every row at midnight instead made the
 * most recent judgeable sale always "yesterday 00:00" — and the ingest-health
 * gate, which excludes today as partial, reads that as 24h plus however long
 * today has run. It crosses the 36h staleness threshold every day at noon UTC,
 * so the forecast paused itself on data that was perfectly fine and the seeded
 * suites failed only in the afternoon.
 *
 * Only the last few completed days are re-stamped, and deliberately so. The
 * gate reads the NEWEST completed day; the 30-day revenue windows measure from
 * `now - 30d`, so moving the oldest rows off midnight would slide them in and
 * out of that window depending on the hour the seed ran. Recent days fix the
 * staleness, older days keep the day-alignment those windows assume.
 *
 * Today is stamped an hour ago rather than at midnight. It used to keep
 * midnight on the reasoning that the gate excludes today as partial — true on
 * the day you seed, and false the next morning, when those midnight rows ARE
 * the newest completed day. A database seeded at 16:30 read as 37h stale by the
 * following afternoon and the Planner paused itself, so a fresh checkout met an
 * empty buy list on the screen the product is named after.
 *
 * The clamp keeps it honest either way: an hour ago, or this evening, whichever
 * is earlier, so nothing is stamped in the future for someone seeding at 09:00.
 *
 * A static seed still ages. This buys roughly a day and a half from the moment
 * it runs; past that the honest fix is to seed again, not to widen the gate.
 */
const EVENING_MS = 20 * 3_600_000;
const AN_HOUR_MS = 3_600_000;
/** Captured ONCE, not per call: `saleAt(0)` runs for every product, and reading
 *  the clock inside it stamped each of today's sales a millisecond apart. The
 *  series groups by timestamp, so 30 products became 30 buckets for one day and
 *  the "30-day window" held 52 entries. One value keeps today a single bucket. */
const TODAY_SALE_AT = Math.min(Date.now() - AN_HOUR_MS, utcDay(0).getTime() + EVENING_MS);
function saleAt(daysAgo: number): Date {
  const day = utcDay(daysAgo);
  if (daysAgo === 0) return new Date(TODAY_SALE_AT);
  const recentCompleted = daysAgo <= 3;
  return recentCompleted ? new Date(day.getTime() + EVENING_MS) : day;
}

type Pattern = "steady" | "riser" | "faller" | "stockout_gap" | "dead";

type SeedProduct = {
  sku: string;
  title: string;
  vendor: string;
  productType: string;
  priceKes: number;
  costKes: number;
  /** Average units/day when in stock. */
  baseRate: number;
  pattern: Pattern;
  /** Days of cover to put on the shelf now. 0 = currently stocked out. */
  coverDays: number;
  /** Share of daily units sold at the till (rest is Shopify). */
  posShare: number;
  supplier: number; // index into SUPPLIERS
};

const SUPPLIERS = [
  { name: "Beauty Plus Distributors", country: "KE", currency: "KES", leadTimeAvgDays: 10, leadTimeStdDays: 3, moq: 12 },
  { name: "Haria Industries", country: "KE", currency: "KES", leadTimeAvgDays: 21, leadTimeStdDays: 5, moq: 24 },
  { name: "Orbit Imports", country: "AE", currency: "USD", leadTimeAvgDays: 42, leadTimeStdDays: 10, moq: 48 },
];

// prettier-ignore
const CATALOGUE: SeedProduct[] = [
  { sku: "CAN-SHE-340", title: "Cantu Shea Butter Leave-In 340g",            vendor: "Cantu",           productType: "Hair Care",  priceKes: 1650, costKes: 1050, baseRate: 4.2, pattern: "steady",       coverDays: 5,  posShare: 0.6,  supplier: 2 },
  { sku: "CAN-CUR-340", title: "Cantu Coconut Curling Cream 340g",           vendor: "Cantu",           productType: "Hair Care",  priceKes: 1750, costKes: 1120, baseRate: 2.8, pattern: "riser",        coverDays: 9,  posShare: 0.55, supplier: 2 },
  { sku: "SHM-SHA-384", title: "Shea Moisture Coconut Shampoo 384ml",        vendor: "Shea Moisture",   productType: "Hair Care",  priceKes: 1900, costKes: 1250, baseRate: 1.6, pattern: "steady",       coverDays: 12, posShare: 0.5,  supplier: 2 },
  { sku: "SHM-JBC-384", title: "Shea Moisture Black Castor Oil 384ml",       vendor: "Shea Moisture",   productType: "Hair Care",  priceKes: 2100, costKes: 1380, baseRate: 1.1, pattern: "steady",       coverDays: 18, posShare: 0.5,  supplier: 2 },
  { sku: "NL-GLY-750",  title: "Nice & Lovely Pure Glycerine 750ml",         vendor: "Nice & Lovely",   productType: "Skin Care",  priceKes: 450,  costKes: 260,  baseRate: 8.5, pattern: "stockout_gap", coverDays: 0,  posShare: 0.8,  supplier: 1 },
  { sku: "NL-BJ-250",   title: "Nice & Lovely Baby Jelly 250g",              vendor: "Nice & Lovely",   productType: "Skin Care",  priceKes: 320,  costKes: 180,  baseRate: 6.0, pattern: "steady",       coverDays: 14, posShare: 0.85, supplier: 1 },
  { sku: "DAR-EMB-3X",  title: "Darling Empress Braid 3X",                   vendor: "Darling",         productType: "Hair Extensions", priceKes: 850, costKes: 520, baseRate: 5.5, pattern: "stockout_gap", coverDays: 0, posShare: 0.75, supplier: 1 },
  { sku: "DAR-YAK-14",  title: "Darling Yaki Weave 14\"",                    vendor: "Darling",         productType: "Hair Extensions", priceKes: 1400, costKes: 880, baseRate: 2.2, pattern: "steady",   coverDays: 10, posShare: 0.7,  supplier: 1 },
  { sku: "GAR-VCS-30",  title: "Garnier Even & Matte Serum 30ml",            vendor: "Garnier",         productType: "Skin Care",  priceKes: 1550, costKes: 980,  baseRate: 3.1, pattern: "riser",        coverDays: 8,  posShare: 0.5,  supplier: 0 },
  { sku: "GAR-MIC-400", title: "Garnier Micellar Water 400ml",               vendor: "Garnier",         productType: "Skin Care",  priceKes: 1250, costKes: 790,  baseRate: 2.4, pattern: "steady",       coverDays: 16, posShare: 0.5,  supplier: 0 },
  { sku: "NIV-PR-400",  title: "Nivea Perfect & Radiant Lotion 400ml",       vendor: "Nivea",           productType: "Skin Care",  priceKes: 950,  costKes: 590,  baseRate: 3.8, pattern: "steady",       coverDays: 11, posShare: 0.65, supplier: 0 },
  { sku: "NIV-MDS-100", title: "Nivea Men Dark Spot Face Wash 100ml",        vendor: "Nivea",           productType: "Skin Care",  priceKes: 720,  costKes: 430,  baseRate: 1.9, pattern: "steady",       coverDays: 20, posShare: 0.6,  supplier: 0 },
  { sku: "LOR-SLG-200", title: "L'Oreal Studio Line Gel 200ml",              vendor: "L'Oreal",         productType: "Hair Care",  priceKes: 980,  costKes: 610,  baseRate: 0.9, pattern: "faller",       coverDays: 75, posShare: 0.55, supplier: 2 },
  { sku: "MAY-FIT-110", title: "Maybelline Fit Me Foundation 110",           vendor: "Maybelline",      productType: "Makeup",     priceKes: 1450, costKes: 900,  baseRate: 1.7, pattern: "steady",       coverDays: 13, posShare: 0.45, supplier: 2 },
  { sku: "MAY-COL-BLK", title: "Maybelline Colossal Mascara Black",          vendor: "Maybelline",      productType: "Makeup",     priceKes: 1150, costKes: 700,  baseRate: 2.1, pattern: "steady",       coverDays: 0,  posShare: 0.45, supplier: 2 },
  { sku: "FLO-ML-04",   title: "Flormar Matte Lipstick 04",                  vendor: "Flormar",         productType: "Makeup",     priceKes: 850,  costKes: 500,  baseRate: 1.3, pattern: "steady",       coverDays: 9,  posShare: 0.4,  supplier: 2 },
  { sku: "BOP-TC-FND",  title: "Black Opal True Color Foundation",           vendor: "Black Opal",      productType: "Makeup",     priceKes: 2450, costKes: 1600, baseRate: 0.8, pattern: "steady",       coverDays: 22, posShare: 0.4,  supplier: 2 },
  { sku: "ORS-REL-KIT", title: "ORS Olive Oil Relaxer Kit",                  vendor: "ORS",             productType: "Hair Care",  priceKes: 1100, costKes: 680,  baseRate: 1.4, pattern: "steady",       coverDays: 15, posShare: 0.7,  supplier: 1 },
  { sku: "TCB-HF-250",  title: "TCB Naturals Hair Food 250g",                vendor: "TCB",             productType: "Hair Care",  priceKes: 520,  costKes: 300,  baseRate: 3.4, pattern: "steady",       coverDays: 17, posShare: 0.8,  supplier: 1 },
  { sku: "DL-AN-CRM",   title: "Dark & Lovely Curl Defining Cream",          vendor: "Dark & Lovely",   productType: "Hair Care",  priceKes: 1350, costKes: 850,  baseRate: 1.2, pattern: "riser",        coverDays: 12, posShare: 0.6,  supplier: 1 },
  { sku: "SSC-LJ-125",  title: "Let's Jam Shining Gel 125g",                 vendor: "Softsheen",       productType: "Hair Care",  priceKes: 780,  costKes: 470,  baseRate: 1.8, pattern: "steady",       coverDays: 19, posShare: 0.7,  supplier: 1 },
  { sku: "VEN-HF-150",  title: "Venus Hair Fertilizer 150g",                 vendor: "Venus",           productType: "Hair Care",  priceKes: 480,  costKes: 280,  baseRate: 2.6, pattern: "steady",       coverDays: 8,  posShare: 0.85, supplier: 1 },
  { sku: "MOV-HJ-200",  title: "Movit Herbal Jelly 200g",                    vendor: "Movit",           productType: "Hair Care",  priceKes: 350,  costKes: 200,  baseRate: 4.6, pattern: "steady",       coverDays: 10, posShare: 0.85, supplier: 1 },
  { sku: "ARI-MJ-90",   title: "Arimis Milking Jelly 90ml",                  vendor: "Arimis",          productType: "Skin Care",  priceKes: 250,  costKes: 140,  baseRate: 9.8, pattern: "steady",       coverDays: 6,  posShare: 0.9,  supplier: 1 },
  { sku: "VAS-BS-250",  title: "Vaseline Blue Seal Jelly 250ml",             vendor: "Vaseline",        productType: "Skin Care",  priceKes: 430,  costKes: 250,  baseRate: 5.2, pattern: "steady",       coverDays: 12, posShare: 0.8,  supplier: 0 },
  { sku: "E45-ML-500",  title: "E45 Moisturising Lotion 500ml",              vendor: "E45",             productType: "Skin Care",  priceKes: 1850, costKes: 1200, baseRate: 0.7, pattern: "steady",       coverDays: 25, posShare: 0.5,  supplier: 2 },
  { sku: "NEU-HB-50",   title: "Neutrogena Hydro Boost Gel 50ml",            vendor: "Neutrogena",      productType: "Skin Care",  priceKes: 2900, costKes: 1950, baseRate: 0.5, pattern: "faller",       coverDays: 30, posShare: 0.4,  supplier: 2 },
  { sku: "REV-CS-3N",   title: "Revlon ColorSilk 3N",                        vendor: "Revlon",          productType: "Hair Care",  priceKes: 750,  costKes: 450,  baseRate: 1.5, pattern: "steady",       coverDays: 14, posShare: 0.6,  supplier: 2 },
  { sku: "BIO-SO-60",   title: "Bio Oil Skincare Oil 60ml",                  vendor: "Bio Oil",         productType: "Skin Care",  priceKes: 1650, costKes: 1080, baseRate: 0.9, pattern: "dead",         coverDays: 0,  posShare: 0.5,  supplier: 2 },
  { sku: "MIK-TS-500",  title: "Mikalla Treatment Shampoo 500ml",            vendor: "Mikalla",         productType: "Hair Care",  priceKes: 1200, costKes: 760,  baseRate: 0.8, pattern: "dead",         coverDays: 0,  posShare: 0.6,  supplier: 1 },
];

/** Owner-defined categories (the Category facet), seeded from productType and
 *  grouped the way an owner would — broader than Shopify's product types, which
 *  is the whole point of a custom category. */
const CUSTOM_CATEGORY: Record<string, string> = {
  "Hair Care": "Hair",
  "Hair Extensions": "Hair",
  "Skin Care": "Skin",
  Makeup: "Makeup",
};

/** SKUs seeded with zero stock right now (the stockouts tile). */
export const STOCKOUT_SKUS = ["NL-GLY-750", "DAR-EMB-3X", "MAY-COL-BLK"];
/** SKUs with stock on the shelf but no sales in the tracked window — dead under
 *  the 90-day dead-stock default (spec §11). */
export const DEAD_SKUS = ["BIO-SO-60", "MIK-TS-500"];
const DEAD_STOCK_UNITS: Record<string, number> = { "BIO-SO-60": 42, "MIK-TS-500": 58 };

/** Daily unit demand for one product across the window, oldest day first. */
function demandCurve(p: SeedProduct, index: number): number[] {
  const rng = mulberry32(1000 + index * 97);
  const out: number[] = [];
  for (let day = 0; day < DAYS; day++) {
    const daysAgo = DAYS - 1 - day;
    // Dead SKUs: no sales anywhere in the window — stock sits idle past the
    // 90-day dead-stock threshold.
    if (p.pattern === "dead") {
      out.push(0);
      continue;
    }
    // Stockout gap: shelf empty days 55..41 ago (14 days), and again from 6 days
    // ago to now (matches the zero on-hand this seed leaves them with).
    if (p.pattern === "stockout_gap" && ((daysAgo <= 55 && daysAgo >= 42) || daysAgo <= 6)) {
      out.push(0);
      continue;
    }
    let rate = p.baseRate;
    if (p.pattern === "riser") rate *= 0.6 + (0.8 * day) / DAYS;
    if (p.pattern === "faller") rate *= 1.4 - (1.0 * day) / DAYS;
    // Fri/Sat uplift, quiet Sundays.
    const dow = utcDay(daysAgo).getUTCDay();
    if (dow === 5 || dow === 6) rate *= 1.45;
    if (dow === 0) rate *= 0.6;
    // Noise: 0.4x..1.6x, occasionally a zero-sale day for slow movers.
    const noisy = rate * (0.4 + rng() * 1.2);
    const qty = Math.round(noisy);
    out.push(qty > 0 ? qty : rng() < 0.15 ? 1 : 0);
  }
  return out;
}

export type SeedResult = {
  tenantId: string;
  userId: string;
  productCount: number;
  locationIds: string[];
  salesRows: number;
};

export async function seedDev(): Promise<SeedResult> {
  // Rebuild the tenant from scratch; keep the user (sessions survive).
  await prismaService.tenant.deleteMany({ where: { slug: DEV_TENANT_SLUG } });
  const tenant = await prismaService.tenant.create({
    // Growth, not the null default — the demo has to reach every shipped screen.
    data: { name: DEV_TENANT_NAME, slug: DEV_TENANT_SLUG, plan: "growth" },
  });

  // Clean slate for demo users so renamed/removed logins stop working — only the
  // creds this seed defines authenticate. @wezesha.test is never a real domain.
  const stale = await prismaService.user.findMany({
    where: { email: { endsWith: "@wezesha.test" } },
    select: { id: true },
  });
  if (stale.length) {
    const ids = stale.map((u) => u.id);
    await prismaService.session.deleteMany({ where: { userId: { in: ids } } });
    await prismaService.account.deleteMany({ where: { userId: { in: ids } } });
    await prismaService.membership.deleteMany({ where: { userId: { in: ids } } });
    await prismaService.user.deleteMany({ where: { id: { in: ids } } });
  }

  const passwordHash = await hashPassword(DEV_USER_PASSWORD);
  const user = await prismaService.user.upsert({
    where: { email: DEV_USER_EMAIL },
    update: { name: "Amara Owner" },
    create: { id: "dev-user-owner", name: "Amara Owner", email: DEV_USER_EMAIL, emailVerified: true },
  });
  // Better Auth credential account: accountId = user id, providerId "credential".
  const existing = await prismaService.account.findFirst({
    where: { userId: user.id, providerId: "credential" },
  });
  if (existing) {
    await prismaService.account.update({ where: { id: existing.id }, data: { password: passwordHash } });
  } else {
    await prismaService.account.create({
      data: { id: `acct-${user.id}`, accountId: user.id, providerId: "credential", userId: user.id, password: passwordHash },
    });
  }
  await prismaService.membership.create({
    data: { userId: user.id, tenantId: tenant.id, role: "OWNER", displayName: "Amara Owner" },
  });

  // Admin + member (staff) users in the same tenant, so QA can test role-based
  // access — especially that a member never sees cost or profit (money-blind).
  async function seedRoleUser(email: string, name: string, password: string, role: "ADMIN" | "MEMBER") {
    const hash = await hashPassword(password);
    const u = await prismaService.user.upsert({
      where: { email },
      update: { name },
      create: { id: `dev-user-${role.toLowerCase()}`, name, email, emailVerified: true },
    });
    const acct = await prismaService.account.findFirst({ where: { userId: u.id, providerId: "credential" } });
    if (acct) {
      await prismaService.account.update({ where: { id: acct.id }, data: { password: hash } });
    } else {
      await prismaService.account.create({
        data: { id: `acct-${u.id}`, accountId: u.id, providerId: "credential", userId: u.id, password: hash },
      });
    }
    await prismaService.membership.create({
      data: { userId: u.id, tenantId: tenant.id, role, displayName: name },
    });
  }
  await seedRoleUser(DEV_ADMIN_EMAIL, "Amara Admin", DEV_ADMIN_PASSWORD, "ADMIN");
  await seedRoleUser(DEV_MEMBER_EMAIL, "Amara Staff", DEV_MEMBER_PASSWORD, "MEMBER");

  const suppliers = [];
  for (const s of SUPPLIERS) {
    suppliers.push(await prismaService.supplier.create({ data: { tenantId: tenant.id, ...s } }));
  }

  const shop = await prismaService.location.create({
    data: { tenantId: tenant.id, name: "Kilimani Shop", isPrimary: true, locationType: "branch", roleStatus: "confirmed" },
  });
  const warehouse = await prismaService.location.create({
    data: { tenantId: tenant.id, name: "Industrial Area Warehouse", locationType: "warehouse", roleStatus: "confirmed" },
  });

  const salesRows: {
    tenantId: string;
    productId: string;
    date: Date;
    quantity: number;
    revenueKes: number;
    channel: string;
  }[] = [];
  const levelRows: {
    tenantId: string;
    locationId: string;
    productId: string;
    onHand: number;
    available: number;
  }[] = [];

  for (let i = 0; i < CATALOGUE.length; i++) {
    const p = CATALOGUE[i]!;
    const curve = demandCurve(p, i);
    const last30 = curve.slice(-30).reduce((s, q) => s + q, 0);

    const onHand =
      p.pattern === "dead"
        ? DEAD_STOCK_UNITS[p.sku]!
        : p.coverDays === 0
          ? 0
          : Math.max(1, Math.round((last30 / 30) * p.coverDays));
    // Backstock in the warehouse (Holds) is the slow-moving overstock and dead
    // lines; everything actively selling sits on the shop floor. So only
    // fallers/dead split off a warehouse share — fast movers are shop-only, and
    // their sellable on-hand equals their whole position.
    const inWarehouse = p.pattern === "faller" || p.pattern === "dead";
    const shopShare = inWarehouse ? Math.ceil(onHand * 0.6) : onHand;
    const warehouseShare = onHand - shopShare;
    // Every fourth product has stock already promised to a customer order, so
    // available sits below on-hand for part of the catalogue and the difference
    // is visible locally instead of the seed hiding it by making them equal.
    // The shop floor is where orders are picked from; the warehouse holds none.
    const committed = i % 4 === 0 ? Math.min(shopShare, 1 + (i % 3)) : 0;

    const product = await prismaService.product.create({
      data: {
        tenantId: tenant.id,
        sku: p.sku,
        title: p.title,
        vendor: p.vendor,
        productType: p.productType,
        customCategory: CUSTOM_CATEGORY[p.productType] ?? null,
        priceKes: p.priceKes,
        costKes: p.costKes,
        costSource: "manual",
        // Seeded stock is what a live, published catalogue looks like: without
        // this every row reads as unlisted, since an unpublished product is
        // exactly a null publishedAt.
        shopifyStatus: "active",
        publishedAt: utcDay(0),
        // Sellable on-hand is the Sells-location rollup only (matches
        // shopify-sync's invariant); warehouse/Holds stock is not sellable.
        // Sellable on-hand, matching what the sync and PO receipt both compute:
        // the Sells-location rollup of AVAILABLE, so committed units are out.
        currentStock: shopShare - committed,
        dailySalesRate: last30 / 30,
        supplierId: suppliers[p.supplier]!.id,
        shopifyCreatedAt: utcDay(DAYS + 120),
      },
    });

    levelRows.push(
      {
        tenantId: tenant.id,
        locationId: shop.id,
        productId: product.id,
        onHand: shopShare,
        available: shopShare - committed,
      },
      {
        tenantId: tenant.id,
        locationId: warehouse.id,
        productId: product.id,
        onHand: warehouseShare,
        available: warehouseShare,
      }
    );

    for (let day = 0; day < DAYS; day++) {
      const qty = curve[day]!;
      if (qty === 0) continue;
      const date = saleAt(DAYS - 1 - day);
      const posQty = Math.round(qty * p.posShare);
      const webQty = qty - posQty;
      if (posQty > 0)
        salesRows.push({ tenantId: tenant.id, productId: product.id, date, quantity: posQty, revenueKes: posQty * p.priceKes, channel: "pos" });
      if (webQty > 0)
        salesRows.push({ tenantId: tenant.id, productId: product.id, date, quantity: webQty, revenueKes: webQty * p.priceKes, channel: "shopify" });
    }
  }

  await prismaService.inventoryLevel.createMany({ data: levelRows });
  for (let at = 0; at < salesRows.length; at += 1000) {
    await prismaService.salesHistory.createMany({ data: salesRows.slice(at, at + 1000) });
  }

  return {
    tenantId: tenant.id,
    userId: user.id,
    productCount: CATALOGUE.length,
    locationIds: [shop.id, warehouse.id],
    salesRows: salesRows.length,
  };
}

// ── Orders demo (opt-in; NOT part of seedDev) ────────────────────────────────
// Purchasing history + a live order queue so the Orders screen demos end to
// end: two delivered POs (one on-time, one late) that give the supplier
// scorecards real data, and pending queue rows ready to become POs. Kept out
// of seedDev so suites that assert on its exact counts stay stable; run the
// script directly (or call this explicitly) to get the full demo state.

/** Whole days ago as a Date (not UTC-midnight — receipt times are moments). */
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

export type OrdersDemoResult = { historicalPos: number; pendingOrders: number };

export async function seedOrdersDemo(tenantId: string): Promise<OrdersDemoResult> {
  const suppliers = await prismaService.supplier.findMany({
    where: { tenantId },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, leadTimeAvgDays: true },
  });
  const products = await prismaService.product.findMany({
    where: { tenantId },
    select: { id: true, sku: true, title: true, costKes: true, currentStock: true },
  });
  const bySku = new Map(products.map((p) => [p.sku, p]));
  const supplierByName = new Map(suppliers.map((s) => [s.name, s]));

  // Re-runnable: clear this section's own rows only.
  await prismaService.purchaseOrder.deleteMany({
    where: { tenantId, poNumber: { in: ["PO-0001", "PO-0002"] } },
  });
  await prismaService.order.deleteMany({ where: { tenantId, status: "pending" } });

  // Deliverable POs need a reachable supplier.
  for (const s of suppliers) {
    const email = `orders@${s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.example`;
    await prismaService.supplier.update({ where: { id: s.id }, data: { email } });
  }

  // Delivered history. Receipts are in the past, so stock levels are NOT
  // touched here — current on-hand already reflects them.
  const history: {
    poNumber: string;
    supplier: string;
    sentDaysAgo: number;
    leadActualDays: number; // received sentDaysAgo - leadActualDays days ago
    lines: { sku: string; quantity: number }[];
  }[] = [
    {
      // 9 days against a 10-day promise — on time, in full.
      poNumber: "PO-0001",
      supplier: "Beauty Plus Distributors",
      sentDaysAgo: 40,
      leadActualDays: 9,
      lines: [
        { sku: "GAR-VCS-30", quantity: 36 },
        { sku: "NIV-PR-400", quantity: 48 },
      ],
    },
    {
      // 25 days against a 21-day promise — late, in full.
      poNumber: "PO-0002",
      supplier: "Haria Industries",
      sentDaysAgo: 30,
      leadActualDays: 25,
      lines: [
        { sku: "NL-BJ-250", quantity: 72 },
        { sku: "MOV-HJ-200", quantity: 48 },
        { sku: "ARI-MJ-90", quantity: 120 },
      ],
    },
  ];

  let historicalPos = 0;
  for (const po of history) {
    const supplier = supplierByName.get(po.supplier);
    if (!supplier) continue;
    const sentAt = daysAgo(po.sentDaysAgo);
    const receivedAt = daysAgo(po.sentDaysAgo - po.leadActualDays);
    const expectedAt =
      supplier.leadTimeAvgDays != null
        ? daysAgo(po.sentDaysAgo - supplier.leadTimeAvgDays)
        : null;
    const lines = po.lines
      .map((l) => ({ ...l, product: bySku.get(l.sku) }))
      .filter((l) => l.product != null);
    await prismaService.purchaseOrder.create({
      data: {
        tenantId,
        supplierId: supplier.id,
        poNumber: po.poNumber,
        status: "received",
        subtotalKes: lines.reduce((s, l) => s + l.quantity * l.product!.costKes, 0),
        createdAt: sentAt,
        sentAt,
        expectedAt,
        receivedAt,
        createdByName: "Amara Owner",
        lines: {
          create: lines.map((l) => ({
            tenantId,
            productId: l.product!.id,
            sku: l.sku,
            title: l.product!.title,
            quantity: l.quantity,
            unitCostKes: l.product!.costKes,
            lineTotalKes: l.quantity * l.product!.costKes,
            recommendedQty: l.quantity,
            receivedQty: l.quantity,
            receivedAt,
          })),
        },
      },
    });
    historicalPos++;
  }

  // The live queue: what the shop should buy next, across all three suppliers.
  // MAY-COL-BLK (30 < MOQ 48) demonstrates the MOQ floor at PO creation.
  const queue: { sku: string; qty: number }[] = [
    { sku: "GAR-VCS-30", qty: 30 },
    { sku: "NIV-PR-400", qty: 36 },
    { sku: "NL-GLY-750", qty: 120 },
    { sku: "DAR-EMB-3X", qty: 80 },
    { sku: "ARI-MJ-90", qty: 150 },
    { sku: "CAN-SHE-340", qty: 60 },
    { sku: "MAY-COL-BLK", qty: 30 },
  ];
  let pendingOrders = 0;
  for (const item of queue) {
    const product = bySku.get(item.sku);
    if (!product) continue;
    await prismaService.order.create({
      data: {
        tenantId,
        status: "pending",
        productId: product.id,
        orderedQty: item.qty,
        stockAtOrder: product.currentStock,
      },
    });
    pendingOrders++;
  }

  return { historicalPos, pendingOrders };
}

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  seedDev()
    .then(async (r) => {
      console.log(
        `seeded tenant ${DEV_TENANT_SLUG} (${r.tenantId}): ${r.productCount} products, ${r.salesRows} sales rows`
      );
      const demo = await seedOrdersDemo(r.tenantId);
      console.log(
        `orders demo: ${demo.historicalPos} delivered POs, ${demo.pendingOrders} queued orders`
      );
      console.log(
        `sign in — owner:  ${DEV_USER_EMAIL} / ${DEV_USER_PASSWORD}\n` +
        `          admin:  ${DEV_ADMIN_EMAIL} / ${DEV_ADMIN_PASSWORD}\n` +
        `          member: ${DEV_MEMBER_EMAIL} / ${DEV_MEMBER_PASSWORD}  (money-blind / staff)`
      );
      return prismaService.$disconnect();
    })
    .catch((err) => {
      console.error("seed-dev failed:", err);
      process.exitCode = 1;
      return prismaService.$disconnect();
    });
}
