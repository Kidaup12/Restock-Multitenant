import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SyncRunView } from "../lib/shopify/sync-run";

// The card is a client component that reaches for the router; a static render
// has no app-router context.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

import {
  ShopifyConnectionCard,
  type ConnectionView,
} from "../app/(shell)/settings/connections/shopify-connection-card";

/**
 * Where a broken store is sent to fix itself.
 *
 * The install route needs this workspace's own client ID and secret. A store
 * that connected by pasting an Admin API token has none by definition, so
 * offering it "Reconnect" is a round trip to ?error=no_app_credentials — the
 * one control it has for getting back, pointed at a dead end. The way back has
 * to match the way in.
 */

const CONNECTION: ConnectionView = {
  shopDomain: "demo-store.myshopify.com",
  installedAt: "2026-07-01 09:00 UTC",
  uninstalledAt: null,
  scopes: "read_products",
  syncPausedAt: "2026-08-13 06:15 UTC",
  authMode: "oauth",
};

const LAST_SYNC = [
  { resource: "products", syncedAt: null },
  { resource: "inventory", syncedAt: null },
  { resource: "orders", syncedAt: null },
];

const FAILED: SyncRunView = {
  id: "run_1",
  status: "failed",
  phase: null,
  phaseIndex: 1,
  phaseTotal: 3,
  itemsDone: 0,
  itemsTotal: null,
  summary: null,
  error: "Shopify auth failed (403)",
  finishedAt: "2026-08-13 06:15 UTC",
  durationSec: 3,
};

const INSTALL_HREF = 'href="/api/shopify/install?shop=demo-store.myshopify.com"';
const TOKEN_HREF = 'href="#shopify-token-connect"';

function render(connection: ConnectionView, appCredentialsConfigured: boolean): string {
  return renderToStaticMarkup(
    <ShopifyConnectionCard
      connection={connection}
      lastSync={LAST_SYNC}
      canManage
      justConnected={false}
      errorCode={null}
      syncRun={FAILED}
      platformAppConfigured={false}
      appCredentialsConfigured={appCredentialsConfigured}
      appClientId={appCredentialsConfigured ? "client-abc" : null}
    />
  );
}

describe("connections card — recovery control matches how the store connected", () => {
  it("sends a token-mode store to the token box, not to the install route", () => {
    const html = render({ ...CONNECTION, authMode: "token" }, false);
    expect(html).not.toContain("/api/shopify/install");
    expect(html).toContain(TOKEN_HREF);
    expect(html).toContain("Paste a new token");
  });

  it("still sends an OAuth store through the install round trip", () => {
    // Without this the defect could be "fixed" by deleting the button.
    const html = render(CONNECTION, true);
    expect(html).toContain(INSTALL_HREF);
    expect(html).toContain("Reconnect");
    expect(html).not.toContain(TOKEN_HREF);
  });

  it("does not offer the install to an OAuth store with no app credentials", () => {
    // Same dead end by a different door: the install route reads the client ID
    // and secret first, so a workspace that never saved them bounces back with
    // no_app_credentials whatever the connection says.
    const html = render(CONNECTION, false);
    expect(html).not.toContain("/api/shopify/install");
    expect(html).toContain(TOKEN_HREF);
  });

  it("names the token box as the thing the paused warning points at", () => {
    // The warning and the button have to agree: telling a token store to
    // "reconnect the store" describes a screen it will never be shown.
    const html = render({ ...CONNECTION, authMode: "token" }, false);
    expect(html).toContain("Paste a fresh token below");
    expect(html).not.toContain("Reconnect the store to resume");
  });

  it("keeps the reconnect wording for a store that really does reinstall", () => {
    const html = render(CONNECTION, true);
    expect(html).toContain("Reconnect the store to resume");
    expect(html).not.toContain("Paste a fresh token below");
  });
});
