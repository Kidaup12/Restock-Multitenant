import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

const { ClassChips } = await import("../app/(shell)/products/catalogue-view");

/**
 * ABC promoted out of the facet dropdown onto the surface.
 *
 * It was always filterable. But the first question a buyer asks a catalogue is
 * "show me the ones that earn", and that should not cost two clicks and a menu.
 * The chips write the same `abc` facet the dropdown does, so the two cannot
 * disagree about what is selected.
 */

const options = [
  { value: "A", label: "A", count: 12 },
  { value: "B", label: "B", count: 45 },
  { value: "C", label: "C", count: 464 },
];

const render = (selected: string[] = []) =>
  renderToStaticMarkup(
    <ClassChips
      options={options}
      selected={selected}
      hrefFor={(abc) => (abc ? `/products?f.abc=${abc.join(",")}` : "/products")}
    />,
  );

describe("class chips", () => {
  it("names the classes by what they earn, not by a letter", () => {
    // "Class A" is jargon an owner has to be taught; "best sellers" is the
    // thing they already think about.
    const html = render();
    expect(html).toContain("Best sellers");
    expect(html).toContain("Steady sellers");
    expect(html).toContain("Slow movers");
    expect(html, "the chips still read as letters").not.toContain(">Class A<");
  });

  it("carries the counts, including the total", () => {
    const html = render();
    expect(html).toContain("12");
    expect(html).toContain("464");
    expect(html, "All does not say how many that is").toContain("521");
  });

  it("marks the selected class and offers to clear it", () => {
    // The weak version checked that SOME chip was current and SOME chip pointed
    // at /products — both true of the always-present All chip, so a selected A
    // chip that re-applied A (href=/products?f.abc=A) instead of clearing would
    // pass. Pull out the A chip's own anchor and assert on IT.
    const html = render(["A"]);
    // Split on anchor opens and take the fragment that names the A chip — no
    // fragile nested-tag regex.
    const aAnchor = html.split("<a ").find((frag) => frag.includes("Best sellers")) ?? "";
    expect(aAnchor, "no A chip rendered").not.toBe("");
    // Clicking the class you are on clears it — its href drops the filter.
    expect(aAnchor, "the selected A chip re-applies A instead of clearing").not.toContain("f.abc=A");
    expect(aAnchor).toContain('href="/products"');
    // …and it is the one marked current.
    expect(aAnchor).toContain('aria-current="true"');
  });

  it("shows All as current when nothing is selected", () => {
    expect(render().match(/aria-current="true"/g) ?? []).toHaveLength(1);
  });

  it("renders nothing when the catalogue has no classes yet", () => {
    // A brand-new shop has no sales, so no ABC. A row of empty chips would be
    // furniture pretending to be a filter.
    expect(
      renderToStaticMarkup(<ClassChips options={[]} selected={[]} hrefFor={() => "/products"} />),
    ).toBe("");
  });
});
