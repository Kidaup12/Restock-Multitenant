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
  connection: ConnectionView = CONNECTION
): string {
  return renderToStaticMarkup(
    <ShopifyConnectionCard
      connection={connection}
      lastSync={LAST_SYNC}
      canManage
      justConnected={justConnected}
      errorCode={null}
      syncRun={syncRun}
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
