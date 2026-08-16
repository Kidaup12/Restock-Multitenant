import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { seedDev, type SeedResult } from "../../../packages/db/scripts/seed-dev";
import { ACTIVITY_PAGE_SIZE, countActivity, getActivity } from "../lib/data/activity";
import {
  activityPageBounds,
  parseActivityQuery,
  withActivityQuery,
} from "../app/(shell)/activity/query";

/**
 * The activity log used to take the newest 100 rows and stop. Nothing on screen
 * said so, so a shop reading its own record saw a complete-looking list that
 * simply ended — the worst kind of missing, because it does not look missing.
 *
 * These cover the three things a paged log has to get right: the total is the
 * whole matched trail (not the page), page 2 is a different page, and searching
 * narrows the trail AND sends the reader back to page 1 rather than to an empty
 * page 3 of a 1-page result.
 */

const runnable = /localhost|127\.0\.0\.1/.test(process.env.SERVICE_DATABASE_URL ?? "");

/** More than two pages, so an off-by-one in the offset has somewhere to show. */
const ROWS = ACTIVITY_PAGE_SIZE * 2 + 20;
const CANCELLED = 7;

let seeded: SeedResult;
let allIds: string[];

describe.skipIf(!runnable)("activity log paging and search (seeded local db)", () => {
  beforeAll(async () => {
    delete process.env.REDIS_URL;
    seeded = await seedDev();
    // Own the whole trail for this tenant so the totals are exact.
    await prismaService.auditEvent.deleteMany({ where: { tenantId: seeded.tenantId } });

    const base = Date.UTC(2026, 0, 1, 12, 0, 0);
    await prismaService.auditEvent.createMany({
      data: Array.from({ length: ROWS }, (_, i) => ({
        tenantId: seeded.tenantId,
        entity: i % 2 === 0 ? "PurchaseOrder" : "Product",
        entityId: `e${i}`,
        // The cancellations sit at the far end of the trail on purpose: a search
        // that only looked at the first page would find none of them.
        action: i >= ROWS - CANCELLED ? "cancelled" : "created",
        actorName: i % 3 === 0 ? "Store staff" : "The owner",
        // Newest first: row 0 is the top of the log.
        createdAt: new Date(base - i * 60_000),
      })),
    });
    // One cost change, for the money-blind check.
    await prismaService.auditEvent.create({
      data: {
        tenantId: seeded.tenantId,
        entity: "Product",
        entityId: "cost1",
        action: "cost_changed",
        actorName: "Store staff",
        meta: { from: 500, to: 650 },
        createdAt: new Date(base + 60_000),
      },
    });

    const rows = await prismaService.auditEvent.findMany({
      where: { tenantId: seeded.tenantId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true },
    });
    allIds = rows.map((r) => r.id);
  }, 180_000);

  afterAll(async () => {
    await prismaService.auditEvent.deleteMany({ where: { tenantId: seeded.tenantId } });
    await prismaService.$disconnect();
  });

  it("counts the whole trail, not the page", async () => {
    const total = await countActivity(seeded.tenantId, { canViewCosts: true, search: "" });
    expect(total).toBe(ROWS + 1);

    const { pageCount, current, start } = activityPageBounds(total, 0);
    expect(pageCount).toBe(Math.ceil((ROWS + 1) / ACTIVITY_PAGE_SIZE));
    expect(current).toBe(0);
    expect(start).toBe(0);

    // Past the end lands on the last page, not on nothing.
    expect(activityPageBounds(total, 99).current).toBe(pageCount - 1);
  });

  it("gives page 2 different rows to page 1, in order", async () => {
    const opts = { canViewCosts: true, currency: "KES" };
    const first = await getActivity(seeded.tenantId, { ...opts, page: 0 });
    const second = await getActivity(seeded.tenantId, { ...opts, page: 1 });

    expect(first).toHaveLength(ACTIVITY_PAGE_SIZE);
    expect(second).toHaveLength(ACTIVITY_PAGE_SIZE);

    const firstIds = first.map((e) => e.id);
    const secondIds = second.map((e) => e.id);
    expect(firstIds).toEqual(allIds.slice(0, ACTIVITY_PAGE_SIZE));
    expect(secondIds).toEqual(allIds.slice(ACTIVITY_PAGE_SIZE, ACTIVITY_PAGE_SIZE * 2));
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
  });

  it("narrows the trail on a search, and sends the reader back to page 1", async () => {
    const total = await countActivity(seeded.tenantId, { canViewCosts: true, search: "" });
    const matched = await countActivity(seeded.tenantId, {
      canViewCosts: true,
      search: "cancelled",
    });
    expect(matched).toBe(CANCELLED);
    expect(matched).toBeLessThan(total);

    // The narrowed list is one page, so a reader sitting on page 3 must not be
    // left there.
    const onPage3 = parseActivityQuery({ page: "3" });
    expect(onPage3.page).toBe(2);
    expect(withActivityQuery(onPage3, { search: "cancelled" }).page).toBe(0);
    expect(withActivityQuery(onPage3, { page: 1 }).page).toBe(1);

    const entries = await getActivity(seeded.tenantId, {
      canViewCosts: true,
      currency: "KES",
      search: "cancelled",
      page: 0,
    });
    expect(entries).toHaveLength(CANCELLED);
    expect(entries.every((e) => e.summary.toLowerCase().includes("cancelled"))).toBe(true);
  });

  it("searches the actor and the plain words on screen, never the meta", async () => {
    const opts = { canViewCosts: true, currency: "KES", page: 0 };

    const byActor = await getActivity(seeded.tenantId, { ...opts, search: "store staff" });
    expect(byActor.length).toBeGreaterThan(0);
    expect(byActor.every((e) => e.actor === "Store staff")).toBe(true);

    // The reader searches what the row says, not the token underneath it.
    const byNoun = await getActivity(seeded.tenantId, { ...opts, search: "purchase order" });
    expect(byNoun.length).toBeGreaterThan(0);
    expect(byNoun.every((e) => e.summary.includes("a purchase order"))).toBe(true);

    // Cost figures live in meta. Searching them would let a reader confirm a
    // number by watching the count move.
    expect(await countActivity(seeded.tenantId, { canViewCosts: true, search: "650" })).toBe(0);
  });

  it("keeps a money-blind member's search clear of cost entries", async () => {
    const blind = { canViewCosts: false, currency: "KES", page: 0 };
    const entries = await getActivity(seeded.tenantId, { ...blind, search: "store staff" });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((e) => e.summary.toLowerCase().includes("cost"))).toBe(false);

    // The count they are shown matches the rows they are shown.
    const matched = await countActivity(seeded.tenantId, {
      canViewCosts: false,
      search: "store staff",
    });
    const viewer = await countActivity(seeded.tenantId, {
      canViewCosts: true,
      search: "store staff",
    });
    expect(matched).toBe(viewer - 1);
  });
});
