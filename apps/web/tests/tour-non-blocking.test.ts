import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The tour points; it must not trap.
 *
 * It used to render a full-page click-blocker (`absolute inset-0` with default
 * pointer events) so nothing on the page could be used until the tour was
 * dismissed — which made the Restock planner's own cards unclickable the moment
 * a first-time owner landed on them, exactly what QA reported. The overlay is
 * now pointer-events:none with only the dialog taking clicks.
 *
 * Read from the source rather than rendered: the failure is a CSS class on a
 * portal that jsdom does not lay out, so the property that matters — "does the
 * layer eat clicks" — is only visible in the markup, and a bare render would
 * pass whether or not the class is there.
 */

const src = readFileSync(
  join(process.cwd(), "components", "tour", "tour-provider.tsx"),
  "utf8",
);

describe("tour overlay does not block the page", () => {
  it("makes the full-viewport layer pass clicks through", () => {
    // The z-50 portal wrapper covers the whole viewport; if it takes pointer
    // events, every button under it — including the planner cards — is dead.
    expect(src, "the tour's full-page layer traps clicks").toMatch(
      /pointer-events-none[^"]*fixed inset-0 z-50|fixed inset-0 z-50[^"]*pointer-events-none/,
    );
  });

  it("keeps the dialog itself clickable", () => {
    // Skip / Next / Back live on the dialog; a blanket pointer-events-none
    // without this would make the tour's own controls unusable.
    expect(src, "the tour dialog cannot be clicked").toContain("pointer-events-auto");
  });

  it("no longer carries the bare full-page click-blocker", () => {
    // The `<div className="absolute inset-0" />` with no other classes was the
    // trap. The spotlight and dim are aria-hidden decorations, not this.
    expect(src, "the full-page click-blocker is back").not.toMatch(
      /<div className="absolute inset-0" \/>/,
    );
  });
});
