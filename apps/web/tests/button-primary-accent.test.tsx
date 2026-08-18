import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { Button } from "../components/ui/button";

/**
 * The primary action is the accent, measured off the reference's own create
 * button rather than read off a summary of it. An earlier pass recorded the
 * opposite, made every primary ink, and left the accent unused on every screen
 * — a wrong note is cheap to write and expensive to find, so the colour is
 * pinned here where a change has to be deliberate.
 *
 * Ink is not banned; it carries the active segment of a tab strip. It is only
 * wrong on a button.
 */
describe("the primary button carries the accent", () => {
  it("renders at the accent, not at ink", () => {
    const cls = renderToStaticMarkup(<Button>Add supplier</Button>);
    expect(cls).toContain("bg-accent");
    expect(cls, "ink is the tab-strip active state, not the primary action").not.toContain(
      "bg-ink",
    );
  });

  it("keeps secondary actions on the ghost treatment", () => {
    const cls = renderToStaticMarkup(<Button variant="ghost">Import CSV</Button>);
    expect(cls).toContain("bg-surface");
    expect(cls).not.toContain("bg-accent");
  });
});
