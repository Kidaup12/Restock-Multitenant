import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectionBanner, connectionNotice } from "../components/shell/connection-banner";
import type { ConnectionState } from "../lib/admin/fleet";

/**
 * A shop whose Shopify sync has stopped used to find out only by opening
 * Settings → Connections. Every screen kept rendering the last successful
 * pull's numbers, and nothing looked wrong — the same silent-staleness shape
 * that cost the nightly forecast two unnoticed nights.
 */

const BROKEN: ConnectionState[] = ["none", "uninstalled", "paused"];

describe("connection banner", () => {
  it("says nothing while the store is syncing", () => {
    expect(connectionNotice("live")).toBeNull();
    expect(renderToStaticMarkup(<ConnectionBanner state="live" canFix />)).toBe("");
  });

  it("names the consequence for every way a store can stop syncing", () => {
    for (const state of BROKEN) {
      const notice = connectionNotice(state);
      expect(notice, state).not.toBeNull();
      // The point is not "disconnected" — it is that the numbers on screen have
      // stopped tracking the shop.
      expect(notice!.message.toLowerCase(), state).toMatch(/syncing|frozen/);
      expect(notice!.action.length, state).toBeGreaterThan(0);
    }
  });

  it("distinguishes never-connected from stopped", () => {
    expect(connectionNotice("none")!.action).toBe("Connect a store");
    expect(connectionNotice("uninstalled")!.action).toBe("Reconnect");
    // Paused is ours, not the merchant's: the store kept refusing our access.
    expect(connectionNotice("paused")!.message).toContain("refusing");
  });

  it("offers the fix only to someone who can apply it", () => {
    const owner = renderToStaticMarkup(<ConnectionBanner state="uninstalled" canFix />);
    expect(owner).toContain("/settings/connections");
    expect(owner).toContain("Reconnect");

    // A member cannot open Settings — tell them, but don't send them to a wall.
    const member = renderToStaticMarkup(<ConnectionBanner state="uninstalled" canFix={false} />);
    expect(member).toContain("syncing"); // apostrophes arrive HTML-escaped
    expect(member).not.toContain("/settings/connections");
  });
});
