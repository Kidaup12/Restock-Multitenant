import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SyncRunView } from "../lib/shopify/sync-run";

// The card is a client component that reaches for the router; a static render
// has no app-router context.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

import {
  ShopifyConnectionCard,
  type ConnectionView,
} from "../app/(shell)/settings/connections/shopify-connection-card";

/**
 * What the Connections card says in each state of a sync.
 *
 * This is a SERVER render with no effects, no socket and no polling — which is
 * exactly the property the design depends on: a screen loaded cold in the
 * middle of a sync has to be right on the strength of the stored row alone.
 */

const CONNECTION: ConnectionView = {
  shopDomain: "demo-store.myshopify.com",
  installedAt: "2026-07-01 09:00 UTC",
  uninstalledAt: null,
  scopes: "read_products",
  syncPausedAt: null,
};

const LAST_SYNC = [
  { resource: "products", syncedAt: null },
  { resource: "inventory", syncedAt: null },
  { resource: "orders", syncedAt: null },
];

function run(over: Partial<SyncRunView> = {}): SyncRunView {
  return {
    id: "run_1",
    status: "running",
    phase: "products",
    phaseIndex: 1,
    phaseTotal: 3,
    itemsDone: 1240,
    itemsTotal: 5310,
    summary: null,
    error: null,
    finishedAt: null,
    durationSec: null,
    ...over,
  };
}

function render(
  syncRun: SyncRunView | null,
  justConnected = false,
  connection: ConnectionView | null = CONNECTION
): string {
  return renderToStaticMarkup(
    <ShopifyConnectionCard
      connection={connection}
      lastSync={LAST_SYNC}
      canManage
      justConnected={justConnected}
      errorCode={null}
      syncRun={syncRun}
      appCredentialsConfigured
      appClientId="client-abc"
    />
  );
}

describe("connections card — sync states", () => {
  it("says nothing has synced yet when there is no run", () => {
    const html = render(null);
    expect(html).toContain("never");
    expect(html).toContain("Connected");
    expect(html).not.toContain("progressbar");
    expect(html).toContain("Sync now");
  });

  it("shows the phase, the counts and a determinate bar while running", () => {
    const html = render(run());
    expect(html).toContain("Products");
    expect(html).toContain("step 1 of 3");
    expect(html).toContain("1,240 of 5,310 products");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="23"'); // 1240/5310
    expect(html).toContain("Syncing");
    // Starting a second sync while one runs is the mistake the guard exists for.
    expect(html).toContain("disabled");
  });

  it("shows an indeterminate bar while the fetch has no total to report", () => {
    const html = render(run({ phase: "orders", phaseIndex: 3, itemsDone: 0, itemsTotal: null }));
    expect(html).toContain("Fetching sales history from Shopify…");
    expect(html).toContain("progress-indeterminate");
    // No denominator means no percentage — the bar must not claim one.
    expect(html).not.toContain("aria-valuenow");
  });

  it("reports what a finished run wrote, and how long it took", () => {
    const html = render(
      run({
        status: "ok",
        phase: null,
        summary: "5,310 products · 3 locations · 812 sales days",
        finishedAt: "2026-07-28 12:02 UTC",
        durationSec: 252,
      })
    );
    expect(html).toContain("5,310 products · 3 locations · 812 sales days");
    expect(html).toContain("took 4m 12s");
    expect(html).toContain("Connected");
    expect(html).not.toContain("progressbar");
  });

  it("surfaces the failure and offers a retry", () => {
    const html = render(run({ status: "failed", error: "Shopify auth failed (401)" }));
    expect(html).toContain("Shopify auth failed (401)");
    expect(html).toContain("Sync failed");
    expect(html).toContain("Retry sync");
  });

  it("calls out a run that stopped responding instead of spinning for ever", () => {
    const html = render(run({ status: "stalled", phase: "inventory", phaseIndex: 2 }));
    expect(html).toContain("stopped responding");
    expect(html).toContain("Sync may have stopped");
    expect(html).toContain("Retry sync");
    expect(html).not.toContain("progressbar");
  });

  it("tells a shop whose token keeps being refused what to actually do", () => {
    const paused = { ...CONNECTION, syncPausedAt: "2026-08-04 06:15 UTC" };
    // A failed run is true at the same time, but "Sync failed" does not tell
    // anyone that no further sync will be attempted until they act.
    const html = render(run({ status: "failed", error: "Shopify auth failed (403)" }), false, paused);
    expect(html).toContain("Reconnect required");
    expect(html).not.toContain("Sync failed");
    expect(html).toContain("Automatic syncs are paused");
    expect(html).toContain("Reconnect");
    // The manual retry is the one way out that does not need a full OAuth round
    // trip, so it must not be disabled along with everything else.
    expect(html).toContain("Retry sync");
  });

  it("shows no paused warning on a healthy store", () => {
    // Guards against an unconditional badge — the assertion above would pass
    // just as happily if the card always said it.
    const html = render(run({ status: "failed", error: "Shopify auth failed (403)" }));
    expect(html).not.toContain("Reconnect required");
    expect(html).not.toContain("Automatic syncs are paused");
    expect(html).toContain("Sync failed");
  });

  it("asks for the workspace's own app credentials, and never echoes the secret", () => {
    const html = render(null);
    expect(html).toContain("Your Shopify app");
    // Maintenance, not onboarding: no step numbering when there is no step two.
    expect(html).not.toContain("1. Add your app");
    expect(html).toContain("Configured");
    expect(html).toContain('aria-label="Shopify app API secret"');
    // The client id is not a secret and is shown back; the stored secret never
    // reaches the client at all, so it cannot appear anywhere in the markup.
    expect(html).toContain("client-abc");
  });

  it("does not say a sync is running while the store is refusing us", () => {
    // Dave's screenshot: a "Syncing" badge and "the first sync is running in
    // the background" sitting directly above a banner explaining the store had
    // rejected the credentials. A queued run is not a working one - after a
    // refusal there is ALWAYS one queued, and it fails for the same reason.
    // A run IS queued — that is the point. render(syncRun, justConnected, connection).
    const html = render(run({ status: "running" }), true, {
      shopDomain: "shop.myshopify.com",
      installedAt: "2026-09-01T07:23:00.000Z",
      uninstalledAt: null,
      scopes: "read_products",
      syncPausedAt: null,
      lastAuthError: "Shopify rejected the app credentials (400)",
      lastAuthErrorAt: "2026-09-01T07:23:00.000Z",
    } as ConnectionView);

    expect(html, "the badge still reads Syncing over a refusal").toContain("Needs attention");
    expect(html).not.toContain("The first sync is running in the background");
  });

  it("warns that the credentials route is limited to our own organisation", () => {
    // These credentials are the shop's OWN app - nothing here is shared, and
    // Wezesha holds no Shopify app at all. The grant still requires the store to
    // sit in the same Shopify organisation as the app, which only a development
    // store does. Three rounds of setup went into a live store that could never
    // have used it, so the limit is stated where the fields are.
    expect(render(null)).toContain("Only works if the store is a development store");
  });

  it("leads a new workspace with the route its own shop can actually use", () => {
    // The install link is the route merchants are asked for, so it is the tab a
    // new workspace opens on. The token route stays one click away rather than
    // buried: it needs no distribution, no review and no Partner account, so it
    // is the way through when Shopify answers "this app can't be installed yet"
    // — which a tester hit, and which reads as our fault.
    // "First" is which tab is selected, not which appears higher. They are tabs
    // rather than one stacked page because all three were fillable at once, and
    // app credentials silently beat a pasted token in the worker — see
    // shopify-connect-routes.test.tsx.
    const html = render(null, false, null);
    expect(html).toContain('name="shopify-admin-token"');
    // The other routes are offered, but as tabs the reader has to choose.
    expect(html).toContain("Install link");
    expect(html).not.toContain('name="shopify-install-shop"');
  });

  it("offers the token route to a store that is connected but cannot sync", () => {
    // The case this exists for: our OAuth install cannot complete (draft
    // listing, unregistered app), so "Reconnect" sends someone in a circle.
    // Pasting a token from the shop's own app is the only way back that does
    // not depend on our app, and it was previously hidden behind "no connection
    // yet" — unreachable exactly when it was needed.
    const paused = { ...CONNECTION, syncPausedAt: "2026-08-04 08:15 UTC" };
    const html = render(run({ status: "failed", error: "Shopify auth failed (403)" }), false, paused);
    expect(html).toContain("Create an app in your store admin instead");
    expect(html).toContain('aria-label="Admin API access token"');
    expect(html).toContain("This replaces the current connection.");
  });

  it("does not invite a healthy store to swap its credentials", () => {
    const html = render(run({ status: "ok", summary: "12 products", finishedAt: "2026-08-04 08:00 UTC" }));
    expect(html).not.toContain("Create an app in your store admin instead");
    expect(html).not.toContain('aria-label="Admin API access token"');
  });

  it("says queued between connecting a store and the worker picking the job up", () => {
    // Straight after OAuth there is no row yet — the gap this covers.
    const html = render(null, true);
    expect(html).toContain("Queued");
  });

  it("does not show the previous run's finish time while a new one is queued", () => {
    const html = render(run({ status: "ok", summary: "12 products", finishedAt: "2026-07-27 08:00 UTC" }), true);
    expect(html).toContain("Queued");
    expect(html).not.toContain("2026-07-27 08:00 UTC");
  });
});
