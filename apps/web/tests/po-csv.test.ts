import { describe, expect, it } from "vitest";
import { toQuickBooksCsv, toGenericPoCsv, poCsvFilenameBase } from "../lib/po/po-csv";
import type { PoDocumentData } from "../lib/po/po-model";

/** Pure builders over PoDocumentData — no DOM, no db. The document is shaped with
 *  cost visibility already applied, so a money-blind fixture carries null costs. */

function doc(overrides: Partial<PoDocumentData> = {}): PoDocumentData {
  return {
    poNumber: "PO-0007",
    status: "sent",
    createdAt: new Date("2026-06-14T09:00:00.000Z"),
    sentAt: new Date("2026-06-15T09:00:00.000Z"),
    expectedAt: new Date("2026-06-25T09:00:00.000Z"),
    currency: "KES",
    shop: { name: "Beauty Square" },
    supplier: { name: "K-Beauty Wholesalers", email: "sales@kbw.co", country: "Kenya" },
    lines: [
      { sku: "11392", title: "Snail Mucin Essence", quantity: 4, unitCostKes: 500, lineTotalKes: 2000 },
      { sku: "11393", title: "Aloe Sun SPF", quantity: 2, unitCostKes: 700, lineTotalKes: 1400 },
    ],
    subtotalKes: 3400,
    totalUnits: 6,
    createdByName: "Amina",
    ...overrides,
  };
}

/** A money-blind document: every cost figure nulled, as buildPoDocument shapes it. */
function moneyBlind(): PoDocumentData {
  return doc({
    lines: [
      { sku: "11392", title: "Snail Mucin Essence", quantity: 4, unitCostKes: null, lineTotalKes: null },
      { sku: "11393", title: "Aloe Sun SPF", quantity: 2, unitCostKes: null, lineTotalKes: null },
    ],
    subtotalKes: null,
  });
}

describe("toQuickBooksCsv", () => {
  it("emits the QuickBooks PO column set (line columns first, QBO grid order) one row per line", () => {
    const lines = toQuickBooksCsv(doc()).split("\r\n");
    // strip the leading BOM the writer prepends by default
    expect(lines[0].replace(/^﻿/, "")).toBe(
      "Product/Service,SKU,Description,Qty,Rate,Amount,Vendor,PurchaseOrder No,PurchaseOrder Date,Memo"
    );
    expect(lines).toHaveLength(3);
    // Product/Service, SKU, Description, Qty, Rate, Amount, Vendor, PurchaseOrder No, PurchaseOrder Date, Memo(=PO no)
    // Date is the sent date (2026-06-15), not created (2026-06-14).
    expect(lines[1]).toBe(
      "Snail Mucin Essence,11392,Snail Mucin Essence,4,500,2000,K-Beauty Wholesalers,PO-0007,2026-06-15,PO-0007"
    );
  });

  it("falls back to 'Unassigned' for the Vendor column when the PO has no supplier", () => {
    const lines = toQuickBooksCsv(doc({ supplier: null })).split("\r\n");
    expect(lines[1]).toContain(",Unassigned,");
  });

  it("leaves Rate/Amount cells blank (positional grid intact) for a money-blind document", () => {
    const lines = toQuickBooksCsv(moneyBlind()).split("\r\n");
    // Qty then two empty cells (Rate, Amount) then the Vendor — the columns hold.
    expect(lines[1]).toBe(
      "Snail Mucin Essence,11392,Snail Mucin Essence,4,,,K-Beauty Wholesalers,PO-0007,2026-06-15,PO-0007"
    );
  });
});

describe("toGenericPoCsv", () => {
  it("emits the plain supplier sheet with cost columns when costs are visible", () => {
    const lines = toGenericPoCsv(doc(), true).split("\r\n");
    expect(lines[0].replace(/^﻿/, "")).toBe("Supplier,SKU,Product,Qty,Unit cost,Line total");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe("K-Beauty Wholesalers,11392,Snail Mucin Essence,4,500,2000");
  });

  it("drops the cost columns entirely when the caller can't view costs", () => {
    const lines = toGenericPoCsv(moneyBlind(), false).split("\r\n");
    expect(lines[0].replace(/^﻿/, "")).toBe("Supplier,SKU,Product,Qty");
    expect(lines[1]).toBe("K-Beauty Wholesalers,11392,Snail Mucin Essence,4");
  });
});

describe("poCsvFilenameBase", () => {
  it("builds a route-safe base from the PO number and format", () => {
    expect(poCsvFilenameBase(doc(), "quickbooks")).toBe("PO-0007-quickbooks");
    expect(poCsvFilenameBase(doc({ poNumber: "PO 12/A" }), "generic")).toBe("PO-12-A-generic");
  });
});
