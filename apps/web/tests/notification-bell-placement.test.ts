import { describe, expect, it } from "vitest";
import { panelPlacementClass } from "@/components/shell/notification-bell";

/**
 * The panel has to open into the screen.
 *
 * The desktop bell sits in the BOTTOM-LEFT corner of the sidebar, and the panel
 * opened down-and-left from it: measured on production at left:-199 in a 1264px
 * viewport and top:649 in a 649px one — off screen on both axes. It still
 * opened, still fetched, and still marked everything read, so pressing it only
 * cleared the unread badge. Worse than an inert button: it consumed the
 * "Forecast paused — your sales feed looks stopped" notice, the one that
 * explains an empty buy list.
 *
 * Tested as a pure mapping because the bug WAS the coordinate. A test that
 * rendered the panel and checked it existed would have passed the whole time.
 */

describe("where the notification panel opens", () => {
  it("opens upward from a bell anchored at the bottom", () => {
    const cls = panelPlacementClass("above-start");
    expect(cls, "the panel still drops below a bottom-anchored bell").toContain("bottom-full");
    expect(cls).not.toContain("mt-2");
  });

  it("opens rightward from a bell anchored at the left", () => {
    const cls = panelPlacementClass("above-start");
    expect(cls, "the panel still extends left off a left-anchored bell").toContain("left-0");
    expect(cls).not.toContain("right-0");
  });

  it("keeps the top-bar bell opening down and to the left", () => {
    // The mobile mount is top-RIGHT, where the original placement is correct.
    // Fixing one corner must not break the other.
    const cls = panelPlacementClass("below-end");
    expect(cls).toContain("right-0");
    expect(cls).toContain("mt-2");
    expect(cls).not.toContain("bottom-full");
  });

  it("gives the two corners different placements", () => {
    expect(panelPlacementClass("above-start")).not.toBe(panelPlacementClass("below-end"));
  });
});
