import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SupplierForm } from "@/app/(shell)/suppliers/supplier-form";
import type { SupplierRow } from "@/lib/data/suppliers";

/**
 * A new supplier is priced in the workspace's own currency.
 *
 * The form used to open on USD for every shop. Every workspace here trades in
 * shillings, so the buyer had to correct the field on each supplier they added
 * — and three of the suppliers on record carry USD because nobody did. The
 * figure is decorative on a purchase order (that prints the workspace currency)
 * but it is what the supplier list and its CSV export report.
 */

const noop = () => {};

function selectedCurrency(markup: string): string | null {
  // renderToStaticMarkup marks the chosen <option>, not the <select>.
  const match = markup.match(/<option[^>]*selected[^>]*value="([A-Z]{3})"/) ??
    markup.match(/<option[^>]*value="([A-Z]{3})"[^>]*selected/);
  return match?.[1] ?? null;
}

const render = (defaultCurrency: string, supplier: SupplierRow | null = null) =>
  renderToStaticMarkup(
    <SupplierForm
      supplier={supplier}
      assignableProducts={[]}
      defaultCurrency={defaultCurrency}
      onResult={noop}
      onClose={noop}
    />,
  );

describe("supplier currency default", () => {
  it("opens a new supplier in the workspace's currency", () => {
    expect(selectedCurrency(render("KES"))).toBe("KES");
  });

  it("follows the workspace rather than a fixed currency", () => {
    // The negative control for the test above: if the form hardcoded KES this
    // would still pass, so a second workspace has to move it.
    expect(selectedCurrency(render("AED"))).toBe("AED");
  });

  it("keeps an existing supplier's own currency when editing", () => {
    const existing = { currency: "USD" } as SupplierRow;
    expect(selectedCurrency(render("KES", existing))).toBe("USD");
  });
});
