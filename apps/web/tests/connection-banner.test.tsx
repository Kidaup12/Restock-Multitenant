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

  it("warns a connected store that has stopped sending", () => {
    // The dangerous case, and the one the shop was never told about: connected,
    // nothing failing, and no new data. Every figure still renders.
    const notice = connectionNotice("live", { days: 3 });
    expect(notice).not.toBeNull();
    expect(notice!.message).toContain("3 days");
    expect(notice!.message.toLowerCase()).toContain("out of date");

    const html = renderToStaticMarkup(
      <ConnectionBanner state="live" canFix stale={{ days: 3 }} />
    );
    expect(html).toContain("3 days");
  });

  it("reads naturally on the first day, and when nothing ever arrived", () => {
    expect(connectionNotice("live", { days: 1 })!.message).toContain("over a day");
    expect(connectionNotice("live", { days: null })!.message).toContain("never sent");
  });

  it("stays silent for a QUIET shop that is still syncing", () => {
    // The distinction that makes this safe to show a customer: a shop with no
    // sales today is not a shop with broken data. Staleness is measured on the
    // sync cursor, which advances on every successful pull whether or not
    // anything sold — so `stale` is null and the banner says nothing.
    expect(connectionNotice("live", null)).toBeNull();
    expect(renderToStaticMarkup(<ConnectionBanner state="live" canFix stale={null} />)).toBe("");
  });

  it("prefers the harder failure when a store is both broken and stale", () => {
    // "Disconnected" outranks "not updating" — telling someone their data is a
    // bit old when the store is actually unplugged sends them to the wrong fix.
    expect(connectionNotice("uninstalled", { days: 9 })!.message).toContain("disconnected");
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
