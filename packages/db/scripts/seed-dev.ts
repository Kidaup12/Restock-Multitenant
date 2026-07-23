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
export const DEV_USER_EMAIL = "dev@wezesha.test";
export const DEV_USER_PASSWORD = "Dev12345!";

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

/** SKUs seeded with zero stock right now (the stockouts tile). */
export const STOCKOUT_SKUS = ["NL-GLY-750", "DAR-EMB-3X", "MAY-COL-BLK"];
/** SKUs with no sales for 70+ days but stock on the shelf (the dead-stock tile). */
export const DEAD_SKUS = ["BIO-SO-60", "MIK-TS-500"];
const DEAD_STOCK_UNITS: Record<string, number> = { "BIO-SO-60": 42, "MIK-TS-500": 58 };

/** Daily unit demand for one product across the window, oldest day first. */
function demandCurve(p: SeedProduct, index: number): number[] {
  const rng = mulberry32(1000 + index * 97);
  const out: number[] = [];
  for (let day = 0; day < DAYS; day++) {
    const daysAgo = DAYS - 1 - day;
    // Dead SKUs: a little life in the first ~3 weeks of the window, then nothing.
    if (p.pattern === "dead" && day > 20) {
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
    data: { name: DEV_TENANT_NAME, slug: DEV_TENANT_SLUG },
  });

  const passwordHash = await hashPassword(DEV_USER_PASSWORD);
  const user = await prismaService.user.upsert({
    where: { email: DEV_USER_EMAIL },
    update: { name: "Amara Dev" },
    create: { id: "dev-user-amara", name: "Amara Dev", email: DEV_USER_EMAIL, emailVerified: true },
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
    data: { userId: user.id, tenantId: tenant.id, role: "OWNER", displayName: "Amara Dev" },
  });

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
  const levelRows: { tenantId: string; locationId: string; productId: string; onHand: number }[] = [];

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
    const shopShare = Math.ceil(onHand * 0.6);

    const product = await prismaService.product.create({
      data: {
        tenantId: tenant.id,
        sku: p.sku,
        title: p.title,
        vendor: p.vendor,
        productType: p.productType,
        priceKes: p.priceKes,
        costKes: p.costKes,
        costSource: "manual",
        currentStock: onHand,
        dailySalesRate: last30 / 30,
        supplierId: suppliers[p.supplier]!.id,
        shopifyCreatedAt: utcDay(DAYS + 120),
      },
    });

    levelRows.push(
      { tenantId: tenant.id, locationId: shop.id, productId: product.id, onHand: shopShare },
      { tenantId: tenant.id, locationId: warehouse.id, productId: product.id, onHand: onHand - shopShare }
    );

    for (let day = 0; day < DAYS; day++) {
      const qty = curve[day]!;
      if (qty === 0) continue;
      const date = utcDay(DAYS - 1 - day);
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

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  seedDev()
    .then((r) => {
      console.log(
        `seeded tenant ${DEV_TENANT_SLUG} (${r.tenantId}): ${r.productCount} products, ${r.salesRows} sales rows`
      );
      console.log(`sign in as ${DEV_USER_EMAIL} / ${DEV_USER_PASSWORD}`);
      return prismaService.$disconnect();
    })
    .catch((err) => {
      console.error("seed-dev failed:", err);
      process.exitCode = 1;
      return prismaService.$disconnect();
    });
}
