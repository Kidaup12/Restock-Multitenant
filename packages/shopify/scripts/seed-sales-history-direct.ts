/**
 * Fill a workspace with a catalogue and a year of trading history, written
 * straight to the database.
 *
 * Why this exists: the dev store's entire order history was created in one
 * burst, so every product has a day of history and the run rate — and therefore
 * the whole forecast — is meaningless. Nothing about the buy list can be judged
 * until there is real history behind it.
 *
 * This path needs no Shopify write access, so it works today. It exercises
 * everything downstream of SalesHistory: run-rate blending and its 30/90/365
 * windows, spike damping and detection, ABC, dead stock, cover days, overstock,
 * reorder sizing, cold-start borrowing, and every screen that reads them.
 *
 * What it does NOT exercise is the sync itself — processedAt bucketing, refund
 * netting, cancelled orders, branch attribution. Those need real back-dated
 * Shopify orders (seed-dev-store.ts), which needs a custom-app token with
 * write_orders and is capped at about five orders a minute on a dev store.
 *
 * Usage, from packages/shopify:
 *   node --env-file=../db/.env --import tsx scripts/seed-sales-history-direct.ts --tenant <slug> [--days 455] [--dry-run]
 */
import { prismaService } from "@wezesha/db";
import { buildCatalogue } from "./lib/catalogue";
import { dailyUnits, simulate, type SeedSku } from "./lib/demand-model";

const DAY_MS = 86_400_000;
const SALES_CHUNK = 1000;

type Args = { tenant: string; days: number; dryRun: boolean; seed: number; force: boolean };

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const tenant = get("--tenant");
  if (!tenant) throw new Error("--tenant <slug> is required");
  return {
    tenant,
    days: Number(get("--days") ?? 455),
    seed: Number(get("--seed") ?? 20260728),
    dryRun: argv.includes("--dry-run"),
    force: argv.includes("--force"),
  };
}

/** Cumulative-value Pareto, mirroring how the app classes ABC. Approximate —
 *  it exists so the dry-run can say whether the mix will produce three classes
 *  at all, not to replace the real classifier. */
function abcSplit(values: number[]): { a: number; b: number; c: number } {
  const sorted = [...values].sort((x, y) => y - x);
  const total = sorted.reduce((n, v) => n + v, 0);
  let running = 0;
  const out = { a: 0, b: 0, c: 0 };
  for (const v of sorted) {
    running += v;
    const share = total > 0 ? running / total : 1;
    if (share <= 0.7) out.a++;
    else if (share <= 0.9) out.b++;
    else out.c++;
  }
  return out;
}

function report(skus: SeedSku[], days: number, today: Date): void {
  const sims = skus.map((s) => ({ sku: s, sim: simulate(s, days, today) }));
  const totalUnits = sims.reduce((n, s) => n + s.sim.units, 0);
  const totalRevenue = sims.reduce((n, s) => n + s.sim.revenue, 0);
  const salesRows = sims.reduce((n, s) => n + s.sim.sellingDays, 0);
  const abc = abcSplit(sims.map((s) => s.sim.revenue));
  const dead = sims.filter((s) => s.sim.daysSinceLastSale !== null && s.sim.daysSinceLastSale > 90).length;
  const never = sims.filter((s) => s.sim.units === 0).length;
  const outNow = skus.filter((s) => s.finalStock === 0).length;
  const noCost = skus.filter((s) => s.costKes === null).length;
  const costOverPrice = skus.filter((s) => s.costKes !== null && s.costKes > s.priceKes).length;

  const fmt = (n: number) => Math.round(n).toLocaleString("en-KE");
  console.log(`
Projected store — ${days} days to ${today.toISOString().slice(0, 10)}

  SKUs                 ${skus.length}
  Sales-history rows   ${fmt(salesRows)}
  Units sold           ${fmt(totalUnits)}
  Revenue              KES ${fmt(totalRevenue)}

  ABC split            A ${abc.a} · B ${abc.b} · C ${abc.c}
  Dead (90d+ no sale)  ${dead}
  Never sold           ${never}   (cold-start borrow path)
  Out of stock now     ${outNow}
  Missing cost         ${noCost}
  Cost above price     ${costOverPrice}
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const skus = buildCatalogue({ seed: args.seed, horizonDays: args.days });

  report(skus, args.days, today);
  if (args.dryRun) {
    console.log("Dry run — nothing written. Re-run without --dry-run to apply.\n");
    return;
  }

  const tenant = await prismaService.tenant.findUnique({ where: { slug: args.tenant } });
  if (!tenant) throw new Error(`no workspace with slug "${args.tenant}"`);
  const tenantId = tenant.id;

  // A live Shopify connection means the next sync owns this catalogue and will
  // fight whatever we write. Refuse unless the caller insists.
  const connection = await prismaService.shopifyConnection.findUnique({ where: { tenantId } });
  if (connection && !connection.uninstalledAt && !args.force) {
    throw new Error(
      `"${args.tenant}" has a live Shopify connection (${connection.shopDomain}). ` +
        `Seeded rows would collide with the next sync. Re-run with --force if that is what you want.`
    );
  }

  console.log(`Seeding "${tenant.name}" (${tenantId})…`);

  // Branches, so per-location stock and attribution have somewhere to live.
  const locationNames = ["Westlands Shop", "Kilimani Shop", "Main Warehouse"];
  const locations = [];
  for (const name of locationNames) {
    locations.push(
      await prismaService.location.upsert({
        where: { id: `${tenantId}-seed-${name.toLowerCase().replace(/\W+/g, "-")}` },
        create: {
          id: `${tenantId}-seed-${name.toLowerCase().replace(/\W+/g, "-")}`,
          tenantId,
          name,
          locationType: name.includes("Warehouse") ? "warehouse" : "branch",
          roleStatus: "confirmed",
        },
        update: { name },
      })
    );
  }
  const sellingLocations = locations.filter((l) => l.locationType === "branch");

  // Products. Upsert on (tenantId, sku) so a re-run updates rather than doubles.
  const productIdBySku = new Map<string, string>();
  for (const s of skus) {
    const existing = await prismaService.product.findFirst({
      where: { tenantId, sku: s.sku },
      select: { id: true },
    });
    const data = {
      title: s.title,
      source: "manual",
      priceKes: s.priceKes,
      costKes: s.costKes ?? 0,
      costSource: s.costKes === null ? null : "manual",
      currentStock: s.finalStock,
      // Product age drives the cold-start rule (under 60 days reads as "new"),
      // so a long-dead SKU must look old, not freshly created.
      shopifyCreatedAt: new Date(today.getTime() - (s.firstSaleDaysAgo + 15) * DAY_MS),
    };
    const row = existing
      ? await prismaService.product.update({ where: { id: existing.id }, data })
      : await prismaService.product.create({ data: { tenantId, sku: s.sku, ...data } });
    productIdBySku.set(s.sku, row.id);
  }
  console.log(`  ${productIdBySku.size} products`);

  // Stock split across the selling branches, so the location view is non-trivial.
  for (const s of skus) {
    const productId = productIdBySku.get(s.sku)!;
    const split = Math.floor(s.finalStock / sellingLocations.length);
    for (const [i, loc] of sellingLocations.entries()) {
      const onHand = i === 0 ? s.finalStock - split * (sellingLocations.length - 1) : split;
      await prismaService.inventoryLevel.upsert({
        where: { locationId_productId: { locationId: loc.id, productId } },
        create: { tenantId, locationId: loc.id, productId, onHand },
        update: { onHand },
      });
    }
  }
  console.log(`  stock across ${sellingLocations.length} branches`);

  // Sales history. Replace this channel wholesale so a re-run is idempotent
  // rather than cumulative.
  await prismaService.salesHistory.deleteMany({ where: { tenantId, channel: "seed" } });
  const rows: Array<{
    tenantId: string;
    productId: string;
    date: Date;
    quantity: number;
    revenueKes: number;
    channel: string;
    locationId: string | null;
  }> = [];
  for (const s of skus) {
    const productId = productIdBySku.get(s.sku)!;
    for (let daysAgo = args.days; daysAgo >= 0; daysAgo--) {
      const date = new Date(today.getTime() - daysAgo * DAY_MS);
      const units = dailyUnits(s, date, daysAgo);
      if (units <= 0) continue;
      rows.push({
        tenantId,
        productId,
        date,
        quantity: units,
        revenueKes: units * s.priceKes,
        channel: "seed",
        // Most days attribute to a branch; some stay unattributed, which is what
        // a multi-branch day looks like in real data.
        locationId: daysAgo % 7 === 0 ? null : sellingLocations[daysAgo % sellingLocations.length]!.id,
      });
    }
  }
  for (let i = 0; i < rows.length; i += SALES_CHUNK) {
    await prismaService.salesHistory.createMany({ data: rows.slice(i, i + SALES_CHUNK) });
  }
  console.log(`  ${rows.length.toLocaleString("en-KE")} sales-history rows`);
  console.log("\nDone. Run the forecast to see it: Today → Run forecast.\n");
}

main()
  .catch((err) => {
    console.error(`\nSeeding failed: ${(err as Error).message}`);
    process.exit(1);
  })
  .finally(() => prismaService.$disconnect());
