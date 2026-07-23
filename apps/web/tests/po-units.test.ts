import { describe, expect, it } from "vitest";
import { nextPoNumber } from "../lib/po/po-number";
import { applyMoq, buildPoLines, subtotal } from "../lib/po/po-math";
import {
  actualLeadDays,
  computeSupplierScore,
  leadTimeStats,
} from "../lib/po/supplier-stats";
import { buildPoDocument } from "../lib/po/po-model";
import { poEmailHtml, poEmailSubject, poEmailText } from "../lib/po/po-email";

/** Pure PO logic: numbering, sizing math, supplier scoring, email rendering. */

const DAY_MS = 86_400_000;

describe("nextPoNumber", () => {
  it("starts at PO-0001 with no history and no floor", () => {
    expect(nextPoNumber([])).toBe("PO-0001");
  });

  it("continues from the max existing number, not the count", () => {
    // A deleted PO-0002 leaves a gap; count+1 would collide with PO-0003.
    expect(nextPoNumber(["PO-0001", "PO-0003"])).toBe("PO-0004");
  });

  it("respects the tenant floor (external numbering continues)", () => {
    expect(nextPoNumber(["PO-0002"], 1100)).toBe("PO-1101");
  });

  it("counts legacy suffixed numbers and ignores date-prefixed series", () => {
    expect(nextPoNumber(["PO-0109WEZ", "PO-20260605-0068", "not-a-po"])).toBe("PO-0110");
  });
});

describe("po sizing math", () => {
  it("applyMoq floors the quantity at the supplier minimum", () => {
    expect(applyMoq(30, 48)).toBe(48);
    expect(applyMoq(60, 48)).toBe(60);
    expect(applyMoq(0.4, 1)).toBe(1);
  });

  it("buildPoLines merges duplicate products, floors at MOQ, keeps the recommendation", () => {
    const lines = buildPoLines(
      [
        { productId: "p1", sku: "A", title: "A", qty: 20, unitCostKes: 100 },
        { productId: "p1", sku: "A", title: "A", qty: 10, unitCostKes: 100 },
        { productId: "p2", sku: "B", title: "B", qty: 12, unitCostKes: 250 },
      ],
      48
    );
    expect(lines).toHaveLength(2);
    const a = lines.find((l) => l.productId === "p1")!;
    expect(a.recommendedQty).toBe(30); // merged, pre-floor
    expect(a.quantity).toBe(48); // MOQ floor
    expect(a.lineTotalKes).toBe(48 * 100);
    expect(subtotal(lines)).toBe(48 * 100 + 48 * 250);
  });
});

describe("supplier scoring", () => {
  const d = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY_MS);

  it("actualLeadDays rounds to whole days and never goes negative", () => {
    expect(actualLeadDays(d(10), d(1))).toBe(9);
    expect(actualLeadDays(d(1), d(1))).toBe(0);
  });

  it("leadTimeStats needs two samples before it reports a spread", () => {
    expect(leadTimeStats([])).toBeNull();
    expect(leadTimeStats([9])).toEqual({ avg: 9, std: null });
    const stats = leadTimeStats([9, 13])!;
    expect(stats.avg).toBe(11);
    expect(stats.std).toBe(3); // sample std of {9,13}
  });

  it("computeSupplierScore derives on-time, fill rate and learned lead", () => {
    const score = computeSupplierScore([
      {
        // on time, in full: sent 20d ago, expected 10d ago, arrived 11d ago
        sentAt: d(20),
        expectedAt: d(10),
        receivedAt: d(11),
        lines: [{ quantity: 40, receivedQty: 40 }],
      },
      {
        // late, partial delivery still open (no receivedAt)
        sentAt: d(15),
        expectedAt: d(5),
        receivedAt: null,
        lines: [{ quantity: 60, receivedQty: 30 }],
      },
      {
        // never sent — must not count anywhere
        sentAt: null,
        expectedAt: null,
        receivedAt: null,
        lines: [{ quantity: 10, receivedQty: 0 }],
      },
    ]);
    expect(score.deliveredPos).toBe(2);
    expect(score.onTimePct).toBe(100); // only the completed PO judges the ETA
    expect(score.fillRatePct).toBe(70); // (40 + 30) / (40 + 60)
    expect(score.learnedLeadDays).toBe(9);
  });

  it("reports null scores instead of inventing them", () => {
    const score = computeSupplierScore([]);
    expect(score.onTimePct).toBeNull();
    expect(score.fillRatePct).toBeNull();
    expect(score.learnedLeadDays).toBeNull();
  });
});

describe("po email rendering", () => {
  const doc = buildPoDocument(
    {
      poNumber: "PO-0042",
      status: "draft",
      createdAt: new Date("2026-07-01T08:00:00Z"),
      sentAt: new Date("2026-07-02T08:00:00Z"),
      expectedAt: new Date("2026-07-12T08:00:00Z"),
      currency: "KES",
      subtotalKes: 100_500,
      createdByName: "Amara Dev",
      supplier: { name: "Beauty Plus", email: "orders@bp.example", country: "KE" },
      lines: [
        { sku: "GAR-VCS-30", title: "Garnier <Serum>", quantity: 36, unitCostKes: 980, lineTotalKes: 35_280 },
      ],
    },
    "Amara Beauty"
  );

  it("both renderings carry the number, supplier, line and total", () => {
    expect(poEmailSubject(doc)).toBe("Purchase order PO-0042 from Amara Beauty");
    const html = poEmailHtml(doc);
    const text = poEmailText(doc);
    for (const body of [html, text]) {
      expect(body).toContain("PO-0042");
      expect(body).toContain("GAR-VCS-30");
      expect(body).toContain("100,500");
    }
    // HTML-escapes titles; the text fallback keeps them verbatim.
    expect(html).toContain("Garnier &lt;Serum&gt;");
    expect(text).toContain("Garnier <Serum>");
    expect(doc.totalUnits).toBe(36);
  });
});
