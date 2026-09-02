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
    const html = render(["A"]);
    // Clicking the class you are on takes it off, rather than re-applying it.
    expect(html).toContain('href="/products"');
    expect(html).toContain('aria-current="true"');
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
