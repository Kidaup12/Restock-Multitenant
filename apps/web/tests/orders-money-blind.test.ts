import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prismaService } from "@wezesha/db";
import { seedDev, seedOrdersDemo, type SeedResult } from "../../../packages/db/scripts/seed-dev";
import {
  getOrderQueue,
  getPoDetail,
  getPoDocument,
  getPurchaseOrders,
} from "../lib/data/orders";
import { createPoFromOrders } from "../lib/po/create-po";
import { sendPoToSupplier } from "../lib/po/send-po";
import { buildPoDocument, poAmount } from "../lib/po/po-model";
import { sendEmail } from "../lib/email";

/**
 * Money-blindness proof for the Orders surface, at the payload depth: with the
 * MEMBER wiring (canViewCosts=false, exactly what the pages derive from
 * hasPermission(membership, "view_costs")) every Orders getter returns null for
 * its KES cost figures — supplier unit costs, PO line totals, PO subtotals —
 * so the numbers never exist in anything serialized to a money-blind member.
 * What a staff member needs to receive a delivery (PO number, quantities,
 * supplier, status) stays visible either way.
 *
 * The one path that keeps costs regardless of the viewer is the supplier email:
 * the send action authorises it, so the document it carries shows real figures.
 *
 * Skips without the local database.
 */

vi.mock("../lib/email", () => ({ sendEmail: vi.fn(async () => {}) }));
const sendEmailMock = vi.mocked(sendEmail);

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

/** KES fields that are sales figures, visible to every role by design. There are
 *  none on the Orders payloads today; kept in step with member-visibility so the
 *  walker's intent is explicit. */
const REVENUE_KEYS = new Set([
  "revenueKes",
  "priceKes",
  "revenue30dKes",
  "revenuePrev30dKes",
  "budgetKes",
]);

/** Every numeric non-revenue `*Kes` leaf in a payload, as "path=value". For a
 *  money-blind member this must come back empty — the proof that no cost number
 *  survives serialization. */
function costNumbers(payload: unknown, path = "$"): string[] {
  if (payload === null || typeof payload !== "object") return [];
  if (payload instanceof Date) return [];
  if (Array.isArray(payload)) {
    return payload.flatMap((item, i) => costNumbers(item, `${path}[${i}]`));
  }
  const found: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (/Kes$/.test(key) && !REVENUE_KEYS.has(key) && typeof value === "number") {
      found.push(`${path}.${key}=${value}`);
    }
    found.push(...costNumbers(value, `${path}.${key}`));
  }
  return found;
}

let seeded: SeedResult;

describe.skipIf(!runnable)("orders money-blindness (seeded local db)", () => {
  beforeAll(async () => {
    seeded = await seedDev();
    await seedOrdersDemo(seeded.tenantId);
  }, 120_000);

  afterAll(async () => {
    await prismaService.$disconnect();
  });

  it("order queue: no cost numbers for a member; owner keeps them, same grouping", async () => {
    const member = await getOrderQueue(seeded.tenantId, { canViewCosts: false });
    expect(member.length).toBeGreaterThan(0);
    for (const group of member) {
      expect(group.totalCostKes).toBeNull();
      expect(group.totalUnits).toBeGreaterThan(0); // quantities stay
      for (const line of group.lines) {
        expect(line.unitCostKes).toBeNull();
        expect(line.lineCostKes).toBeNull();
        expect(line.qty).toBeGreaterThan(0);
      }
    }
    expect(costNumbers(member)).toEqual([]);

    const owner = await getOrderQueue(seeded.tenantId, { canViewCosts: true });
    expect(costNumbers(owner).length).toBeGreaterThan(0);
    // Redaction changes only the money — same suppliers, same units.
    expect(member.map((g) => [g.supplierName, g.totalUnits])).toEqual(
      owner.map((g) => [g.supplierName, g.totalUnits])
    );
  });

  it("PO list: subtotals masked for a member; PO number and units stay visible", async () => {
    const member = await getPurchaseOrders(seeded.tenantId, { canViewCosts: false });
    expect(member.length).toBeGreaterThan(0);
    for (const po of member) {
      expect(po.subtotalKes).toBeNull();
      expect(po.poNumber).toMatch(/^PO-/);
      expect(po.totalUnits).toBeGreaterThan(0);
    }
    expect(costNumbers(member)).toEqual([]);

    const owner = await getPurchaseOrders(seeded.tenantId, { canViewCosts: true });
    expect(costNumbers(owner).length).toBeGreaterThan(0);
  });

  it("PO detail: unit costs, line totals and subtotal masked for a member", async () => {
    const list = await getPurchaseOrders(seeded.tenantId, { canViewCosts: true });
    const poId = list[0]!.id;

    const member = await getPoDetail(seeded.tenantId, poId, { canViewCosts: false });
    expect(member).not.toBeNull();
    expect(member!.subtotalKes).toBeNull();
    expect(member!.lines.length).toBeGreaterThan(0);
    for (const line of member!.lines) {
      expect(line.unitCostKes).toBeNull();
      expect(line.lineTotalKes).toBeNull();
      expect(line.quantity).toBeGreaterThan(0); // receiving still works money-blind
    }
    expect(costNumbers(member)).toEqual([]);

    const owner = await getPoDetail(seeded.tenantId, poId, { canViewCosts: true });
    expect(costNumbers(owner).length).toBeGreaterThan(0);
  });

  it("on-screen PO document redacts for a member; owner sees costs", async () => {
    const list = await getPurchaseOrders(seeded.tenantId, { canViewCosts: true });
    const poId = list[0]!.id;

    const member = await getPoDocument(seeded.tenantId, poId, { canViewCosts: false });
    expect(member).not.toBeNull();
    expect(member!.subtotalKes).toBeNull();
    for (const line of member!.lines) {
      expect(line.unitCostKes).toBeNull();
      expect(line.lineTotalKes).toBeNull();
    }
    expect(costNumbers(member)).toEqual([]);

    const owner = await getPoDocument(seeded.tenantId, poId, { canViewCosts: true });
    expect(costNumbers(owner).length).toBeGreaterThan(0);
  });

  it("buildPoDocument masks costs only when the viewer can't see them", () => {
    const row = {
      poNumber: "PO-9001",
      status: "draft",
      createdAt: new Date(),
      sentAt: null,
      expectedAt: null,
      currency: "KES",
      subtotalKes: 12_345,
      createdByName: "Amara Dev",
      supplier: { name: "Supplier", email: "s@example", country: "KE" },
      lines: [{ sku: "A", title: "A", quantity: 3, unitCostKes: 100, lineTotalKes: 300 }],
    };
    const shown = buildPoDocument(row, "Amara Beauty", { canViewCosts: true });
    expect(shown.subtotalKes).toBe(12_345);
    expect(shown.lines[0]!.unitCostKes).toBe(100);
    expect(shown.lines[0]!.lineTotalKes).toBe(300);

    const hidden = buildPoDocument(row, "Amara Beauty", { canViewCosts: false });
    expect(hidden.subtotalKes).toBeNull();
    expect(hidden.lines[0]!.unitCostKes).toBeNull();
    expect(hidden.lines[0]!.lineTotalKes).toBeNull();
    // Non-cost fields are untouched.
    expect(hidden.lines[0]!.quantity).toBe(3);
    expect(hidden.poNumber).toBe("PO-9001");
    expect(hidden.totalUnits).toBe(3);
  });

  it("supplier email carries costs on the authorized send path", async () => {
    // Build a draft PO from the live queue, then send it. The send path renders
    // the document with costs because the supplier is authorised to quote
    // against them — independent of any viewing member's permission.
    const queue = await getOrderQueue(seeded.tenantId, { canViewCosts: true });
    const group = queue.find((g) => g.supplierId != null)!;
    const created = await createPoFromOrders(
      seeded.tenantId,
      group.lines.map((l) => l.orderId),
      { userId: seeded.userId, name: "Amara Dev" }
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    sendEmailMock.mockClear();
    const result = await sendPoToSupplier(seeded.tenantId, created.poId);
    expect(result.ok).toBe(true);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);

    const message = sendEmailMock.mock.calls[0]![0];
    // The subtotal the supplier is billed appears in both renderings.
    const detail = (await getPoDetail(seeded.tenantId, created.poId, { canViewCosts: true }))!;
    const subtotalStr = poAmount(detail.subtotalKes);
    expect(subtotalStr).not.toBe("•••");
    expect(message.html).toContain(subtotalStr);
    expect(message.text).toContain(subtotalStr);
  });
});
