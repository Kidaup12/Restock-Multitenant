import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The supplier queue card has to add up.
 *
 * Its header has run the real `buildPoLines` since the totals were corrected,
 * so it quotes the MOQ-adjusted units and cash. The line table went on printing
 * the raw queued quantity, so a card read 60 + 30 = 90 units above a button
 * promising 108, and the 18 units the minimum added were named only in a note.
 * The purchase order itself was always right — only this screen could not be
 * reconciled against it.
 *
 * These render the card and read the numbers back out of the HTML, so a future
 * change that stops running the shared sizing here fails.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

import { CurrencyProvider } from "../components/currency-provider";
import { QueueGroup } from "../app/(shell)/orders/queue-group";
import type { OrderQueueGroup } from "../lib/data/orders";
import { buildPoLines, subtotal } from "../lib/po/po-math";

/** Orbit Imports on the seeded demo: MOQ 48, and one line queued below it. */
const MOQ = 48;
const lines = [
  {
    orderId: "o-1",
    productId: "p-1",
    sku: "CAN-SHE-340",
    title: "Cantu Shea Butter Leave-In 340g",
    qty: 60,
    unitCostKes: 1050,
    lineCostKes: 63_000,
    onHandUnits: 20,
  },
  {
    orderId: "o-2",
    productId: "p-2",
    sku: "MAY-COL-BLK",
    title: "Maybelline Colossal Mascara Black",
    qty: 30, // below the minimum — this is the line that moves
    unitCostKes: 700,
    lineCostKes: 21_000,
    onHandUnits: 0,
  },
];

const group: OrderQueueGroup = {
  supplierId: "s-1",
  supplierName: "Orbit Imports",
  moq: MOQ,
  leadTimeAvgDays: 42,
  score: null,
  lines,
  totalUnits: 90,
  totalCostKes: 84_000,
};

function render(canViewCosts = true) {
  return renderToStaticMarkup(
    <CurrencyProvider currency="KES">
      <QueueGroup group={group} canViewCosts={canViewCosts} />
    </CurrencyProvider>
  );
}

/** Digits inside the quantity column, in document order. */
function orderQtyCells(html: string): number[] {
  const rows = html.split("<tr").slice(2); // skip the header row
  return rows.map((row) => {
    const cells = row.split("<td");
    // 0 is the fragment before the first cell; cells are tick, product, stock, qty…
    const qty = cells[4] ?? "";
    const shown = qty.match(/>(\d[\d,]*)</g)?.[0] ?? "";
    return Number(shown.replace(/[^\d]/g, ""));
  });
}

describe("the supplier queue card adds up", () => {
  it("shows the quantity each line will actually be ordered at", () => {
    const html = render();
    // The floored line shows 48, not the 30 that was queued...
    expect(html).toContain("raised from 30");
    // ...and the untouched line says nothing about being raised.
    expect(html).not.toContain("raised from 60");
  });

  it("makes the line quantities sum to the figure on the button", () => {
    const html = render();
    const planned = buildPoLines(
      lines.map((l) => ({
        productId: l.productId,
        sku: l.sku,
        title: l.title,
        qty: l.qty,
        unitCostKes: l.unitCostKes,
      })),
      MOQ
    );
    const headerUnits = planned.reduce((s, l) => s + l.quantity, 0);
    expect(headerUnits).toBe(108); // 60 + 48

    // This is the reconciliation the card failed: rows against header.
    expect(orderQtyCells(html).reduce((s, n) => s + n, 0)).toBe(headerUnits);
    expect(html).toContain(`Create PO · ${headerUnits} units`);
  });

  it("prices each line at the quantity it shows", () => {
    const html = render();
    const planned = buildPoLines(
      lines.map((l) => ({
        productId: l.productId,
        sku: l.sku,
        title: l.title,
        qty: l.qty,
        unitCostKes: l.unitCostKes,
      })),
      MOQ
    );
    // 48 x 700 = 33,600, not the queued 21,000.
    expect(html).toContain("KES 33,600");
    expect(html).not.toContain("KES 21,000");
    expect(subtotal(planned)).toBe(96_600);
  });

  it("still hides the money from a member who cannot see costs", () => {
    const html = render(false);
    expect(html).toContain("raised from 30");
    expect(html).not.toContain("33,600");
  });
});
