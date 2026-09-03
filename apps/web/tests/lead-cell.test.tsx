import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { CatalogueRow } from "@/lib/data/stock";
import { validateLeadDays, MAX_LEAD_DAYS } from "@/lib/catalogue/lead-time";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

const { RowGroup } = await import("../app/(shell)/products/catalogue-view");

/**
 * The inline lead-time editor.
 *
 * It refused bad input by silently putting the old number back. Type 400,
 * press Enter, watch "14d" reappear — no message, no reason, and the same
 * outcome whether the value was rejected here or by the server. A control that
 * fails the same way it succeeds teaches people it is broken.
 */

const row = (over: Partial<CatalogueRow> = {}): CatalogueRow =>
  ({
    productId: "p1", sku: "NL-BJ-250", title: "Nice & Lovely Baby Jelly 250g",
    variantTitle: null, shopifyProductId: null, vendor: "Nice & Lovely",
    onHandUnits: 12, warehouseUnits: 0, daysCover: 20, urgency: "low",
    priceKes: 400, runRate: 0.6, revenue30dKes: 7200, costKes: 200,
    stockValueKes: 2400, moneyAtRestKes: 2400, abc: null, customCategory: null,
    costSource: "manual", notForSale: false, lifecycle: "active",
    lifecycleLabel: "Active", buyable: true, lifecycleReason: null,
    onOrderUnits: 0, expectedArrivalAt: null, syncError: null, syncErrorAt: null,
    leadDays: 14, leadSource: "supplier", supplierName: "Haria",
    verdict: "healthy", marginPct: 50, missingCost: false, suspectCost: false,
    heldOffBuyList: false, costMovedPct: null, costMovedAt: null,
    facet: { productId: "p1", brand: "Nice & Lovely", productType: null, category: null,
             supplier: null, supplierGroup: null, speedBand: null, abc: "A", health: [] },
    ...over,
  }) as CatalogueRow;

const render = (canManage = true) =>
  renderToStaticMarkup(
    <table>
      <tbody>
        <RowGroup row={row()} open={false} onToggle={() => {}} canViewCosts canManage={canManage}
          categoryNames={[]} flags={{ active: true, activeOverride: false }} picked={false} />
      </tbody>
    </table>,
  );

describe("lead time editor", () => {
  it("gives the trigger something to return focus to", () => {
    // Enter and Escape both used to unmount the focused input and leave focus
    // on <body>, so the next Tab restarted from the top of the page.
    //
    // Tied to the lead label, not to "a button somewhere": the row's expand
    // toggle is also a button, so a bare <button check passes even with this
    // cell rendered as an inert span.
    expect(render()).toMatch(/<button[^>]*title="[^"]*click to change[^"]*"[^>]*>[^<]*14d/);
  });

  it("offers no editor to a reader who cannot manage the catalogue", () => {
    expect(render(false), "a read-only reader was given an edit control").not.toContain(
      "click to change",
    );
  });
});

/* The validation the editor actually runs — imported, not restated. A copy of
   the rule in the test passes happily while the component's bounds change
   underneath it, which is the failure this whole file exists to prevent. */
describe("an unclassified product", () => {
  it("says why it has no class rather than showing a bare dash", () => {
    // A dash on every row reads as a broken column. The class comes from the
    // nightly run, and a product with no sales has not earned one — the
    // reference labels everything "C", which is tidier and untrue.
    const html = render();
    expect(html, "the ABC column is a bare dash").toContain("No sales yet");
  });

  it("still shows a real class when there is one", () => {
    const html = renderToStaticMarkup(
      <table>
        <tbody>
          <RowGroup row={row({ abc: "A" })} open={false} onToggle={() => {}} canViewCosts canManage
            categoryNames={[]} flags={{ active: true, activeOverride: false }} picked={false} />
        </tbody>
      </table>,
    );
    expect(html).toContain(">A<");
    expect(html).not.toContain("No sales yet");
  });
});

describe("lead time validation", () => {
  it("says why, rather than reverting", () => {
    expect(validateLeadDays("400")).toBe("That is over a year — enter 365 or fewer days.");
    expect(validateLeadDays("-5")).toBe("Days cannot be negative.");
    expect(validateLeadDays("abc")).toBe("Enter a number of days.");
  });

  it("accepts a blank as a real choice", () => {
    // Clearing hands the row back to its supplier's lead time; refusing it
    // would make "unset this" impossible.
    expect(validateLeadDays("")).toBeNull();
  });

  it("accepts the boundaries themselves", () => {
    expect(validateLeadDays("0")).toBeNull();
    expect(validateLeadDays(String(MAX_LEAD_DAYS))).toBeNull();
    expect(validateLeadDays(String(MAX_LEAD_DAYS + 1))).not.toBeNull();
  });
});
