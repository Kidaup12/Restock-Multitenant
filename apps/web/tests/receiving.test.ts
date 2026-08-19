import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaService, OUTSTANDING_PO_STATUSES } from "@wezesha/db";
import { seedDev, type SeedResult } from "../../../packages/db/scripts/seed-dev";
import { getPurchaseOrders, countPurchaseOrders } from "../lib/data/orders";

/**
 * Receiving lists what the shop is still waiting for. The two ways that goes
 * wrong are showing an order that has already fully landed — history, not work —
 * and hiding one that is part-received, which is exactly the one someone is
 * standing at the door with.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

let seeded: SeedResult;
const made: string[] = [];

async function po(poNumber: string, status: string, expectedAt: Date | null) {
  const row = await prismaService.purchaseOrder.create({
    data: {
      tenantId: seeded.tenantId,
      poNumber,
      status,
      expectedAt,
      sentAt: new Date(),
      subtotalKes: 1000,
    },
    select: { id: true },
  });
  made.push(row.id);
  return row.id;
}

describe.skipIf(!runnable)("receiving list (seeded local db)", () => {
  beforeAll(async () => {
    delete process.env.REDIS_URL;
    seeded = await seedDev();
    await po("RCV-SENT", "sent", new Date(Date.now() + 3 * 86_400_000));
    await po("RCV-PART", "partially_received", new Date(Date.now() - 2 * 86_400_000));
    await po("RCV-DONE", "received", new Date(Date.now() - 5 * 86_400_000));
    await po("RCV-DRAFT", "draft", null);
  }, 120_000);

  afterAll(async () => {
    await prismaService.purchaseOrder.deleteMany({ where: { id: { in: made } } });
    await prismaService.$disconnect();
  });

  const outstanding = () =>
    getPurchaseOrders(seeded.tenantId, { canViewCosts: true, statuses: OUTSTANDING_PO_STATUSES });

  it("lists what is still owed, and nothing else", async () => {
    const numbers = (await outstanding()).map((r) => r.poNumber);
    expect(numbers).toContain("RCV-SENT");
    // The one someone is most likely at the door with.
    expect(numbers).toContain("RCV-PART");
    // Fully in is history; a draft was never sent to anyone.
    expect(numbers).not.toContain("RCV-DONE");
    expect(numbers).not.toContain("RCV-DRAFT");
  });

  it("reads soonest first, so the next delivery leads", async () => {
    const rows = await getPurchaseOrders(seeded.tenantId, {
      canViewCosts: true,
      statuses: OUTSTANDING_PO_STATUSES,
      orderBy: [{ expectedAt: { sort: "asc", nulls: "last" } }, { sentAt: "desc" }],
    });
    const mine = rows.filter((r) => r.poNumber.startsWith("RCV-"));
    // The overdue one is sooner than the one due in three days.
    expect(mine[0]!.poNumber).toBe("RCV-PART");
  });

  it("flags the overdue delivery as late", async () => {
    const part = (await outstanding()).find((r) => r.poNumber === "RCV-PART");
    expect(part!.isLate).toBe(true);
    const sent = (await outstanding()).find((r) => r.poNumber === "RCV-SENT");
    expect(sent!.isLate).toBe(false);
  });

  it("counts the same set the list shows", async () => {
    // The pager and the list must not disagree about how much is outstanding.
    const [rows, total] = await Promise.all([
      outstanding(),
      countPurchaseOrders(seeded.tenantId, { statuses: OUTSTANDING_PO_STATUSES }),
    ]);
    expect(total).toBe(rows.length);
  });

  it("withholds the order value from a money-blind member", async () => {
    const rows = await getPurchaseOrders(seeded.tenantId, {
      canViewCosts: false,
      statuses: OUTSTANDING_PO_STATUSES,
    });
    for (const row of rows) expect(row.subtotalKes).toBeNull();
    // Units are not money, so the member still sees what is owed.
    expect(rows.every((r) => typeof r.totalUnits === "number")).toBe(true);
  });
});
