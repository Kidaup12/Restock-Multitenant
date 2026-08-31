import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The card is a client component: it takes the router on render, and there is
// no app router mounted under renderToStaticMarkup. Nothing here navigates —
// this only asserts the first paint.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

import { ShopifyConnectionCard } from "../app/(shell)/settings/connections/shopify-connection-card";

/**
 * The three ways to connect a store must be mutually exclusive on screen.
 *
 * Stacked on one page they were all fillable at once, and filling two is not a
 * harmless duplicate: the worker resolves app credentials FIRST and never reads
 * a pasted token when a credential row exists (apps/worker/src/shopify-sync.ts,
 * resolveAccessToken). A store connected both ways probes green at connect time
 * and then dies about a day later on a minted token nobody renewed — which
 * reads as the merchant revoking us.
 *
 * So this asserts the shape of the first screen a new workspace sees, not the
 * styling: the token fields are present, and the credential fields are not
 * reachable without changing tab.
 */

type Props = Parameters<typeof ShopifyConnectionCard>[0];

const props: Props = {
  connection: null,
  lastSync: [],
  canManage: true,
  justConnected: false,
  errorCode: null,
  syncRun: null,
  appCredentialsConfigured: false,
  appClientId: null,
};

const render = (over: Partial<Props> = {}) =>
  renderToStaticMarkup(<ShopifyConnectionCard {...props} {...over} />);

describe("connecting a store: one route at a time", () => {
  it("opens on the token route, which is the one that always works", () => {
    const html = render();
    expect(html).toContain('name="shopify-admin-token"');
    expect(html).toContain('name="shopify-token-shop"');
  });

  it("does not put the app-credential fields on the same screen", () => {
    // The combination the worker silently resolves in the credentials' favour.
    // Unreachable rather than discouraged is the whole point of the tabs.
    const html = render();
    expect(html).not.toContain('name="shopify-client-id"');
    expect(html).not.toContain('name="shopify-api-secret"');
  });

  it("does not put the published-app install on the same screen either", () => {
    expect(render()).not.toContain('name="shopify-install-shop"');
  });

  it("offers two routes, named for what the shop owner has", () => {
    const html = render();
    expect(html).toContain('role="tablist"');
    for (const label of [
      "Paste a token from your store",
      "Use an app you registered with Shopify",
    ]) {
      expect(html).toContain(label);
    }
  });

  it("does not offer a third route for what is only step one of the second", () => {
    // Saving a client ID and secret is not an alternative to installing with
    // them - it is the step before. Presented as a sibling tab it sat AFTER the
    // tab that depends on it, and the install error told people to look
    // "above", where nothing was.
    const html = render();
    expect(html).not.toContain("Client ID &amp; secret");
    expect(html).not.toContain("Install a published app");
  });

  it("keeps the credential box on the page once a store is connected", () => {
    // Changing an app's secret is maintenance, not a way in — so a connected
    // workspace still reaches it without hunting through tabs.
    const html = render({
      connection: {
        shopDomain: "shop.myshopify.com",
        installedAt: "2026-08-01T00:00:00.000Z",
        uninstalledAt: null,
        scopes: "read_products",
        syncPausedAt: null,
      },
    });
    expect(html).toContain('name="shopify-client-id"');
    expect(html).not.toContain('role="tablist"');
  });

  it("shows a reader who cannot manage connections no way in at all", () => {
    const html = render({ canManage: false });
    expect(html).not.toContain('name="shopify-admin-token"');
    expect(html).not.toContain('name="shopify-client-id"');
    expect(html).toContain("Ask a workspace owner or admin");
  });
});
