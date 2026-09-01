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
 * styling: one route's fields are on screen, and the other two are not
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
  it("opens on the token route, the only one a merchant's own shop can use", () => {
    // Shopify's client-credentials grant works only when the app and the store
    // share an organisation, and installing does not change that — so both the
    // install link and the client ID/secret dead-end on a merchant's shop. A
    // custom app made in the shop's own admin needs no Partner account.
    const html = render();
    expect(html).toContain('name="shopify-admin-token"');
    // The other two routes' fields stay off the first paint.
    expect(html).not.toContain('name="shopify-client-id"');
    expect(html).not.toContain('name="shopify-install-shop"');
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

  it("offers three routes, named for what the shop owner has", () => {
    const html = render();
    expect(html).toContain('role="tablist"');
    for (const label of ["Admin API token", "Install link", "Client ID &amp; secret"]) {
      expect(html).toContain(label);
    }
  });

  it("lists the working route first, then the two that need an app of ours", () => {
    // Saving a client ID and secret is the step before installing with them, so
    // it sits next to the install tab rather than at the end. Order is the whole
    // point: a prerequisite listed last is one people look for and miss.
    const html = render();
    const order = ["Admin API token", "Install link", "Client ID &amp; secret"].map((l) =>
      html.indexOf(l),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it.skip("sends someone with no credentials saved to the tab that takes them", () => {
    // The install route cannot work without them, and a disabled field with no
    // way out was the dead end this replaced.
    const html = render({ appCredentialsConfigured: false });
    expect(html).toContain("Add client ID &amp; secret");
    expect(html).not.toContain('name="shopify-install-shop"');
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
