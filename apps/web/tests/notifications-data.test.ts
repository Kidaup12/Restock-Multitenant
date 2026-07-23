import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import {
  clampLimit,
  DEFAULT_PAGE_SIZE,
  getUnreadCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationsRead,
  MAX_PAGE_SIZE,
} from "../lib/notifications/data";

/**
 * Notification-feed data layer against the local database. The functions run
 * on the RLS-enforced tenant client; fixtures and cross-checks go through the
 * service client, so a leaking query shows up as a mismatch. Skips when no
 * local database is configured.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const SLUG_A = "notif-data-test-a";
const SLUG_B = "notif-data-test-b";
const TOTAL_A = 25;

describe("clampLimit", () => {
  it("defaults, clamps, and rejects junk", () => {
    expect(clampLimit(null)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampLimit("abc")).toBe(DEFAULT_PAGE_SIZE);
    expect(clampLimit("0")).toBe(DEFAULT_PAGE_SIZE);
    expect(clampLimit("-3")).toBe(DEFAULT_PAGE_SIZE);
    expect(clampLimit("2.5")).toBe(DEFAULT_PAGE_SIZE);
    expect(clampLimit("5")).toBe(5);
    expect(clampLimit(String(MAX_PAGE_SIZE))).toBe(MAX_PAGE_SIZE);
    expect(clampLimit("999")).toBe(MAX_PAGE_SIZE);
  });
});

describe.skipIf(!runnable)("notification feed (local db, RLS client)", () => {
  let tenantA: string;
  let tenantB: string;
  let idsA: string[]; // newest first, matching the feed order
  let idB: string;

  beforeAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
    const a = await prismaService.tenant.create({ data: { name: "Notif A", slug: SLUG_A } });
    const b = await prismaService.tenant.create({ data: { name: "Notif B", slug: SLUG_B } });
    tenantA = a.id;
    tenantB = b.id;

    const base = Date.now() - TOTAL_A * 1000;
    const created: string[] = [];
    for (let i = 0; i < TOTAL_A; i++) {
      const row = await prismaService.notification.create({
        data: {
          tenantId: tenantA,
          kind: i % 2 === 0 ? "sync_failed" : "shopify_reconnect",
          title: `Notification ${i}`,
          body: i % 3 === 0 ? `Body ${i}` : null,
          createdAt: new Date(base + i * 1000), // strictly increasing
        },
      });
      created.push(row.id);
    }
    idsA = created.reverse(); // newest first

    const rowB = await prismaService.notification.create({
      data: { tenantId: tenantB, kind: "sync_failed", title: "B only" },
    });
    idB = rowB.id;
  });

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
    await prismaService.$disconnect();
  });

  it("counts unread per tenant", async () => {
    expect(await getUnreadCount(tenantA)).toBe(TOTAL_A);
    expect(await getUnreadCount(tenantB)).toBe(1);
  });

  it("pages newest-first with a stable cursor and no overlap or leakage", async () => {
    const first = await listNotifications(tenantA, { limit: 10 });
    expect(first.items).toHaveLength(10);
    expect(first.items.map((n) => n.id)).toEqual(idsA.slice(0, 10));
    expect(first.nextCursor).toBe(idsA[9]);

    const second = await listNotifications(tenantA, { cursor: first.nextCursor, limit: 10 });
    expect(second.items.map((n) => n.id)).toEqual(idsA.slice(10, 20));

    const third = await listNotifications(tenantA, { cursor: second.nextCursor, limit: 10 });
    expect(third.items.map((n) => n.id)).toEqual(idsA.slice(20));
    expect(third.nextCursor).toBeNull();

    // Ordering is strictly newest-first across the whole walk.
    const walked = [...first.items, ...second.items, ...third.items];
    for (let i = 1; i < walked.length; i++) {
      expect(walked[i]!.createdAt < walked[i - 1]!.createdAt).toBe(true);
    }
    // And nothing from tenant B ever appears.
    expect(walked.some((n) => n.id === idB)).toBe(false);
  });

  it("marks a subset read once; re-marking is a no-op", async () => {
    const targets = idsA.slice(0, 3);
    expect(await markNotificationsRead(tenantA, targets)).toBe(3);
    expect(await getUnreadCount(tenantA)).toBe(TOTAL_A - 3);
    expect(await markNotificationsRead(tenantA, targets)).toBe(0);
    expect(await markNotificationsRead(tenantA, [])).toBe(0);
  });

  it("cannot mark another tenant's notification read (RLS)", async () => {
    expect(await markNotificationsRead(tenantA, [idB])).toBe(0);
    const rowB = await prismaService.notification.findUnique({ where: { id: idB } });
    expect(rowB?.readAt).toBeNull();
  });

  it("mark-all clears only its own tenant", async () => {
    expect(await markAllNotificationsRead(tenantA)).toBe(TOTAL_A - 3);
    expect(await getUnreadCount(tenantA)).toBe(0);
    expect(await getUnreadCount(tenantB)).toBe(1); // untouched
  });
});
