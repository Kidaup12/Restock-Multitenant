import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getConnectionStatus } from "../lib/data/connection-status";
import { connectionNotice } from "../components/shell/connection-banner";
import { isStale, staleDays } from "../lib/sync/staleness";

/**
 * The shop-facing end of the same split, wired the way the shell wires it:
 * status → isStale/staleDays → banner. The banner's own docblock has always
 * described this case — "connected and still silent" — while the value it
 * measured was restamped every fifteen minutes whether or not anything arrived,
 * so the warning could not fire.
 *
 * Two production workspaces were in exactly this state: newest sale 22 July and
 * 6 August, both reporting a sync minutes old.
 */

const dbUrl = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(dbUrl);

const SLUG = "connection-freshness";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** What the shell layout does with a status, in one call — so this suite is
 *  testing the path a shop actually sees rather than a private re-derivation. */
function bannerFor(lastSyncedAt: Date | null, now: number) {
  return connectionNotice(
    "live",
    isStale(lastSyncedAt, now) ? { days: staleDays(lastSyncedAt, now) } : null
  );
}

describe.skipIf(!runnable)("connection freshness → banner", () => {
  let db: typeof import("@wezesha/db");
  let tenantId: string;
  const now = Date.now();

  /** Every resource synced two minutes ago; `arrived` is when data last came
   *  back. A silent store has the first without the second. */
  async function setCursors(arrived: Date | null) {
    await db.prismaService.ingestCursor.deleteMany({ where: { tenantId } });
    await db.prismaService.ingestCursor.createMany({
      data: ["products", "inventory", "orders"].map((resource) => ({
        tenantId,
        source: "shopify",
        resource,
        cursor: new Date(now - 2 * 60_000),
        dataAt: arrived,
      })),
    });
  }

  beforeAll(async () => {
    db = await import("@wezesha/db");
    await db.prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    const tenant = await db.prismaService.tenant.create({
      data: { name: "Connection Freshness", slug: SLUG },
    });
    tenantId = tenant.id;
    await db.prismaService.shopifyConnection.create({
      data: {
        tenantId,
        shopDomain: "connection-freshness.myshopify.com",
        accessToken: "ciphertext",
        scopes: "read_products",
      },
    });
  }, 30_000);

  afterAll(async () => {
    await db.prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    await db.prismaService.$disconnect();
  });

  it("a connected store that has sent nothing for days raises the banner", async () => {
    await setCursors(new Date(now - 3 * DAY));

    const status = await getConnectionStatus(tenantId);
    expect(status.state).toBe("live");
    expect(status.lastSyncedAt?.getTime()).toBe(now - 3 * DAY);
    expect(bannerFor(status.lastSyncedAt, now)?.message).toContain("in 3 days");
  }, 30_000);

  it("a store still sending stays silent — the banner is for exceptions", async () => {
    // The control that stops "always report stale" from passing. A shop told
    // its figures are frozen while they are current learns to ignore the bar.
    await setCursors(new Date(now - HOUR));

    const status = await getConnectionStatus(tenantId);
    expect(status.lastSyncedAt?.getTime()).toBe(now - HOUR);
    expect(bannerFor(status.lastSyncedAt, now)).toBeNull();
  }, 30_000);

  it("one resource still arriving keeps the whole store fresh", async () => {
    // Orders alone is enough: the question is "has anything arrived", not
    // "has every phase arrived". A catalogue nobody has edited in a month is
    // not a broken connection.
    await setCursors(new Date(now - 9 * DAY));
    await db.prismaService.ingestCursor.updateMany({
      where: { tenantId, resource: "orders" },
      data: { dataAt: new Date(now - HOUR) },
    });

    const status = await getConnectionStatus(tenantId);
    expect(status.lastSyncedAt?.getTime()).toBe(now - HOUR);
    expect(bannerFor(status.lastSyncedAt, now)).toBeNull();
  }, 30_000);

  it("a connected store that has never delivered anything says exactly that", async () => {
    await setCursors(null);

    const status = await getConnectionStatus(tenantId);
    expect(status.lastSyncedAt).toBeNull();
    expect(bannerFor(status.lastSyncedAt, now)?.message).toContain("never sent");
  }, 30_000);
});
