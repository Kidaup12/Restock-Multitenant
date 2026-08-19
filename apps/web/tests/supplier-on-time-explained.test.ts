import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prismaService } from "@wezesha/db";
import { seedDev, seedOrdersDemo, type SeedResult } from "../../../packages/db/scripts/seed-dev";
import { sendPoToSupplier } from "../lib/po/send-po";
import { receivePoLines } from "../lib/po/receive-po";
import { getSuppliers, type SupplierRow } from "../lib/data/suppliers";
import { getSupplierScores } from "../lib/data/orders";
import { computeSupplierScore } from "../lib/po/supplier-stats";
import { SuppliersView } from "../app/(shell)/suppliers/suppliers-view";
import { SupplierScoreBadges } from "../app/(shell)/orders/supplier-score-badges";

/**
 * On-time compares a delivery against the date promised when the order went
 * out, and that date only exists when the supplier had a lead time at send
 * time. A supplier nobody ever typed a lead time for can therefore take any
 * number of deliveries and never score — and both scorecards used to render
 * that as simple absence, indistinguishable from "no deliveries yet".
 *
 * Two suppliers with the same complete deliveries: the one without a lead time
 * must say why on-time is missing and what fixes it; the one with a lead time
 * must still show a real percentage. Without the second half, "always say
 * unscoreable" would pass.
 */

vi.mock("../lib/email", () => ({ sendEmail: vi.fn(async () => {}) }));

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const NO_LEAD = "Kilimani Wholesale";
const WITH_LEAD = "Ngong Road Depot";

/** Every label the suppliers list can show in place of an on-time figure. The
 *  "names every unscoreable state" test renders each one, so a string that
 *  drifts from the code fails there instead of quietly weakening the
 *  negative assertions that use this list. */
const ON_TIME_GAP_LABELS = [
  "On-time needs a lead time",
  "On-time from your next order",
  "On-time pending",
];

let seeded: SeedResult;
let tenantId: string;
let locationId: string;
let poCounter = 9000;

/** A sent-and-fully-received PO for one supplier: the delivery history the
 *  scorecard grades. */
async function deliverPo(supplierId: string, productId: string, qty: number) {
  const product = await prismaService.product.findUniqueOrThrow({
    where: { id: productId },
    select: { sku: true, title: true, costKes: true },
  });
  const cost = product.costKes ?? 100;
  poCounter += 1;
  const po = await prismaService.purchaseOrder.create({
    data: {
      tenantId,
      supplierId,
      poNumber: `PO-${poCounter}`,
      status: "draft",
      subtotalKes: qty * cost,
      lines: {
        create: [
          {
            tenantId,
            productId,
            sku: product.sku,
            title: product.title,
            quantity: qty,
            unitCostKes: cost,
            lineTotalKes: qty * cost,
          },
        ],
      },
    },
    include: { lines: true },
  });

  const sent = await sendPoToSupplier(tenantId, po.id);
  expect(sent.ok).toBe(true);
  const received = await receivePoLines(
    tenantId,
    po.id,
    po.lines.map((l) => ({ lineId: l.id, qty: l.quantity })),
    locationId
  );
  expect(received.ok).toBe(true);
}

function renderRows(rows: SupplierRow[]): string {
  return renderToStaticMarkup(
    createElement(SuppliersView, {
      rows,
      unassignedBrands: [],
      supplierOptions: [],
      assignableProducts: [],
      defaultCurrency: "KES",
      canManage: true,
    })
  );
}

/** The row's markup, isolated from its neighbours. */
function rowMarkup(rows: SupplierRow[], name: string): string {
  const row = rows.find((r) => r.name === name)!;
  return renderRows([row]);
}

describe.skipIf(!runnable)("on-time explains itself (seeded local db)", () => {
  beforeAll(async () => {
    seeded = await seedDev();
    tenantId = seeded.tenantId;
    await seedOrdersDemo(tenantId);
    const location = await prismaService.location.findFirstOrThrow({
      where: { tenantId },
      orderBy: { isPrimary: "desc" },
      select: { id: true },
    });
    locationId = location.id;

    const products = await prismaService.product.findMany({
      where: { tenantId },
      orderBy: { sku: "asc" },
      take: 5,
      select: { id: true },
    });

    // Two suppliers taking real deliveries; the difference that decides whether
    // on-time can ever be scored is the lead time, set on one and not the other.
    const noLead = await prismaService.supplier.create({
      data: {
        tenantId,
        name: NO_LEAD,
        email: "orders@kilimani.example",
        leadTimeAvgDays: null,
      },
    });
    const withLead = await prismaService.supplier.create({
      data: {
        tenantId,
        name: WITH_LEAD,
        email: "orders@ngong.example",
        leadTimeAvgDays: 14,
      },
    });

    // Three for the no-lead supplier: the learned median (and with it the
    // one-click "Use learned") only appears from the third delivery.
    await deliverPo(noLead.id, products[0].id, 10);
    await deliverPo(noLead.id, products[1].id, 12);
    await deliverPo(noLead.id, products[2].id, 8);
    await deliverPo(withLead.id, products[3].id, 10);
    await deliverPo(withLead.id, products[4].id, 12);
  }, 180_000);

  afterAll(async () => {
    await prismaService.$disconnect();
  });

  it("reports on-time as unscoreable, with the reason, when no date was promised", async () => {
    const rows = await getSuppliers(tenantId);
    const row = rows.find((r) => r.name === NO_LEAD)!;

    expect(row.deliveriesTracked).toBe(3);
    expect(row.leadTimeTypedDays).toBeNull();
    expect(row.onTimePct).toBeNull();
    // The reason, not just the hole: these deliveries carried no promised date.
    expect(row.onTimeStatus).toBe("no_promised_date");
  });

  it("says on the suppliers list why on-time is missing", async () => {
    const rows = await getSuppliers(tenantId);
    const markup = rowMarkup(rows, NO_LEAD);
    expect(markup).toContain("On-time needs a lead time");
    // And points at the fix that is one click away in the same row.
    expect(markup).toContain("Use learned");
  });

  it("says on the order queue's scorecard why on-time is missing", async () => {
    const scores = await getSupplierScores(tenantId);
    const supplier = await prismaService.supplier.findFirstOrThrow({
      where: { tenantId, name: NO_LEAD },
      select: { id: true },
    });
    const score = scores.get(supplier.id)!;
    expect(score.onTimePct).toBeNull();
    expect(score.onTimeStatus).toBe("no_promised_date");

    const markup = renderToStaticMarkup(createElement(SupplierScoreBadges, { score }));
    expect(markup).toContain("Set a lead time to score on-time");
    expect(markup).toContain("/suppliers");
  });

  it("distinguishes deliveries-not-finished from nothing-promised", async () => {
    const supplier = await prismaService.supplier.findFirstOrThrow({
      where: { tenantId, name: WITH_LEAD },
      select: { id: true },
    });
    // A part-received delivery is a different state: nothing is wrong with the
    // supplier's setup, the delivery simply is not finished.
    const partial = await prismaService.purchaseOrder.findFirstOrThrow({
      where: { tenantId, supplierId: supplier.id },
      select: { supplierId: true, sentAt: true, expectedAt: true },
    });
    const inFlight = computeSupplierScore([
      {
        sentAt: partial.sentAt,
        expectedAt: partial.expectedAt,
        receivedAt: null,
        lines: [{ quantity: 10, receivedQty: 4 }],
      },
    ]);
    expect(inFlight.onTimeStatus).toBe("awaiting_completion");
    expect(computeSupplierScore([]).onTimeStatus).toBe("no_deliveries");
  });

  it("names every unscoreable state in shop language", async () => {
    const rows = await getSuppliers(tenantId);
    const base = rows.find((r) => r.name === NO_LEAD)!;
    const states: SupplierRow[] = [
      // No lead time ever set, and enough deliveries to have learned one.
      base,
      // A lead time exists now, but these orders predate it.
      { ...base, leadTimeTypedDays: 14 },
      // Booked in but not finished — nothing wrong, just not gradable yet.
      { ...base, onTimeStatus: "awaiting_completion", learnedLeadDays: null },
    ];
    const shown = states.map((row) => renderRows([row]));
    for (const [i, label] of ON_TIME_GAP_LABELS.entries()) {
      expect(shown[i], label).toContain(label);
    }
  });

  // The discriminating control: complete deliveries against a lead time that
  // was set, so on-time is a real number and no explanation is shown. Without
  // this, "always say unscoreable" would pass every assertion above.
  it("still scores a real percentage for a supplier with a lead time", async () => {
    const rows = await getSuppliers(tenantId);
    const row = rows.find((r) => r.name === WITH_LEAD)!;

    expect(row.deliveriesTracked).toBe(2);
    expect(row.leadTimeTypedDays).toBe(14);
    expect(row.onTimePct).toBe(100);
    expect(row.onTimeStatus).toBe("scored");

    const markup = rowMarkup(rows, WITH_LEAD);
    expect(markup).toContain("On-time 100%");
    // A scored supplier gets no explanation at all. Every label onTimeGap can
    // produce is listed: a "not.toContain" against a string the code never
    // emits passes forever, which is how a broken guard first slipped through.
    for (const label of ON_TIME_GAP_LABELS) expect(markup).not.toContain(label);
  });
});
