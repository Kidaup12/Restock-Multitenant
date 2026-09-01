"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/badge";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { normalizeShopDomain } from "@/lib/shopify/shop-domain";
import { PasswordInput } from "@/components/auth/password-input";
import type { SyncRunView } from "@/lib/shopify/sync-run";
import {
  clearShopifyAppCredentials,
  connectShopifyWithToken,
  removeShopifyStore,
  saveShopifyAppCredentials,
  testShopifyConnection,
} from "./actions";
import { SyncProgress } from "./sync-progress";

/** Named in the setup instructions so a shop ticks the right boxes first time
 *  rather than discovering a missing scope after installing its app. */
const REQUIRED_SCOPE_LABEL =
  "read_products, read_inventory, read_locations and read_orders";

export type ConnectionView = {
  shopDomain: string;
  installedAt: string;
  uninstalledAt: string | null;
  scopes: string;
  /** Set once the store's token has been refused enough times in a row that the
   *  scheduler stopped trying. The app still holds a connection; only a
   *  reconnect makes it usable again. */
  syncPausedAt: string | null;
  /** How the store got its token: "oauth" (our app, via the install round trip)
   *  or "token" (pasted from an app the shop made in its own admin). Absent
   *  reads as oauth, the same default the column carries. */
  authMode?: string;
  /** The last thing Shopify refused us with, shown from the FIRST failure
   *  rather than only once the store is paused. A sync that cannot authenticate
   *  fails before a run row is ever opened, so "Last sync: never" and "the first
   *  sync is running in the background" were the only things on screen while the
   *  real answer sat in the worker log. */
  lastAuthError?: string | null;
  lastAuthErrorAt?: string | null;
};

/** The primary-button look on an anchor. The two ways back out of a broken
 *  connection are real destinations — Shopify's install, or the token box
 *  further down this card — so they are links, and the page says in its markup
 *  which one a store is being sent to. */
const RECOVERY_LINK_CLASS = cn(
  "inline-flex h-10 items-center justify-center rounded-md px-4 text-sm font-medium",
  "bg-accent text-on-accent transition-colors hover:bg-accent-strong",
  "outline-accent focus-visible:outline-2 focus-visible:outline-offset-2",
);

/** Anchor target for the token box, so the recovery link can jump straight to it. */
const TOKEN_PANEL_ID = "shopify-token-connect";

type LastSyncRow = { resource: string; syncedAt: string | null };

const OAUTH_ERRORS: Record<string, string> = {
  forbidden: "Only owners and admins can connect a store.",
  no_app_credentials:
    "That install needs your app's client ID and secret. Add them in step 1 of “Use an app you registered with Shopify”, or paste a token from your store instead — that route needs neither.",
  // Almost always a stale tab: the state cookie lives ten minutes, so a second
  // attempt started in another tab invalidates the first. Saying "expired or
  // tampered with" alone reads as a security event and tells nobody what to do.
  invalid_state:
    "That install link had gone stale — they expire after ten minutes, and starting a second attempt cancels the first. Press Reconnect once and follow it through.",
  invalid_shop: "The store that came back did not match the one you entered.",
  invalid_hmac: "Shopify's signature on the callback did not verify.",
  missing_code: "Shopify did not return an authorization code.",
  exchange_failed: "Could not exchange the authorization code for a token.",
  shop_taken: "That store is already connected to a different workspace.",
};

export function ShopifyConnectionCard({
  connection,
  lastSync,
  canManage,
  justConnected,
  errorCode,
  syncRun,
  appCredentialsConfigured,
  appClientId,
}: {
  connection: ConnectionView | null;
  lastSync: LastSyncRow[];
  canManage: boolean;
  justConnected: boolean;
  errorCode: string | null;
  syncRun: SyncRunView | null;
  /** Whether this workspace has stored its own app credentials. The secret
   *  itself is never sent to the client — only whether one exists. */
  appCredentialsConfigured: boolean;
  /** Safe to show: a client ID is not a secret and travels in the authorize URL. */
  appClientId: string | null;
}) {
  const router = useRouter();
  const [shop, setShop] = useState("");
  const [tokenShop, setTokenShop] = useState("");
  const [token, setToken] = useState("");
  const [clientId, setClientId] = useState(appClientId ?? "");
  const [apiSecret, setApiSecret] = useState("");
  const [busy, setBusy] = useState<
    "sync" | "disconnect" | "token" | "test" | "creds" | "clearCreds" | "install" | "remove" | null
  >(null);
  // Covers the gap between the queue accepting the job and the worker opening
  // its row — the one moment a run exists but nothing durable says so.
  const [queued, setQueued] = useState(justConnected);
  const [queueAttempt, setQueueAttempt] = useState(justConnected ? 1 : 0);
  // Whether a sync is actually in flight. It has to come from the progress
  // component: syncRun is a server render and does not move while a sync runs,
  // so deriving the button state from it would leave "Sync now" disabled until
  // the next full page load.
  const [syncActive, setSyncActive] = useState(syncRun?.status === "running");
  /**
   * Which way in. Two routes, because there are only two: an app the shop makes
   * in its own admin (paste its token), or an app registered in the Partner
   * dashboard (save its credentials, then install with them).
   *
   * They were once stacked on one page, all fillable at once — and filling two
   * is not a harmless duplicate: the worker resolves app credentials FIRST and
   * never reads a pasted token when a credential row exists, so a store
   * connected both ways probes green and then dies about a day later on a
   * minted token nobody renewed. Tabs make that combination unreachable rather
   * than merely discouraged.
   *
   * Credentials keep their own tab, listed straight after the install link
   * that needs them: a merchant who has not saved them yet is shown the way
   * there rather than a disabled field.
   *
   * The token route leads, and this reverses an earlier ordering deliberately.
   * The install link and the client ID/secret both go through an app in OUR
   * Shopify organisation, and Shopify's client-credentials grant only works
   * when the app and the store share an organisation — installing does not
   * change that. A merchant's own shop answers shop_not_permitted whichever of
   * those two they try. A custom app made in the shop's own admin needs no
   * Partner account and no distribution, and its token does not expire, so it
   * is the only route that works for the shops we are actually onboarding.
   */
  const [route, setRoute] = useState<"install" | "credentials" | "token">("token");

  const { confirm, dialog } = useConfirm();
  const [notice, setNotice] = useState<{ tone: "positive" | "warning" | "negative"; text: string } | null>(
    errorCode
      ? { tone: "negative", text: OAUTH_ERRORS[errorCode] ?? "Connecting the store failed." }
      : // Not while the store is refusing us. The connection row exists, so
        // "connected" is technically true and the sync IS queued — but saying
        // the first sync is running above a banner explaining it was refused
        // reads as reassurance, and it is the sentence a merchant believes.
        justConnected && !connection?.lastAuthError
        ? { tone: "positive", text: "Store connected. The first sync is running in the background." }
        : null
  );

  const live = connection !== null && connection.uninstalledAt === null;
  // Still installed as far as the app knows, but every request is being refused.
  const paused = live && connection.syncPausedAt !== null;
  /**
   * Whether the install round trip can actually complete for this store.
   *
   * It reads this workspace's client ID and secret before it does anything
   * else, and redirects straight back to ?error=no_app_credentials when there
   * are none. A store connected by pasting an Admin API token has none by
   * definition — that is the trade — so "Reconnect" was sending exactly the
   * stores that use the token route on a lap of the building. An OAuth store
   * whose credentials were since removed lands in the same place. Either way
   * the way back is the token box below, and it is the route that always works.
   */
  const canReinstall =
    connection !== null && connection.authMode !== "token" && appCredentialsConfigured;
  const syncing = syncActive;
  const onActiveChange = useCallback((value: boolean) => setSyncActive(value), []);
  const onSettled = useCallback((status?: SyncRunView["status"]) => {
    setQueued(false);
    // A run that just succeeded settles every complaint on this card. Without
    // this, a "Test connection" failure from before the store was fixed sits
    // there in red above a sync that has plainly worked.
    if (status === "ok") setNotice(null);
  }, []);

  async function syncNow() {
    setBusy("sync");
    setNotice(null);
    try {
      const res = await fetch("/api/shopify/sync", { method: "POST" });
      const body = (await res.json()) as { enqueued?: boolean; state?: string; error?: string };
      if (!res.ok) {
        setNotice({ tone: "negative", text: body.error ?? "Sync request failed." });
      } else if (body.enqueued) {
        setQueued(true);
        setQueueAttempt((n) => n + 1);
        setNotice({ tone: "positive", text: "Sync started." });
      } else {
        // The no-overlap guard: one sync per store at a time.
        setNotice({
          tone: "warning",
          text: `A sync is already ${body.state === "active" ? "running" : `queued (${body.state})`} — not starting another.`,
        });
      }
    } catch {
      setNotice({ tone: "negative", text: "Sync request failed." });
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    // Tokens and every sync cursor go, and the way back for an OAuth store is a
    // whole install round trip. One click was too few.
    const ok = await confirm({
      title: `Disconnect ${connection?.shopDomain ?? "this store"}`,
      body: "Stock and sales stop updating, and reconnecting starts a fresh sync from scratch.",
      confirmLabel: "Disconnect",
    });
    if (!ok) return;
    setBusy("disconnect");
    setNotice(null);
    try {
      const res = await fetch("/api/shopify/disconnect", { method: "POST" });
      if (res.ok) {
        // Cursors and tokens are gone server-side; leaving the old store's
        // address and a half-typed token in the boxes invites reconnecting to
        // whatever happened to still be sitting there.
        setShop("");
        setTokenShop("");
        setToken("");
        setClientId("");
        setApiSecret("");
        router.refresh();
      } else {
        const body = (await res.json()) as { error?: string };
        setNotice({ tone: "negative", text: body.error ?? "Disconnect failed." });
      }
    } catch {
      setNotice({ tone: "negative", text: "Disconnect failed." });
    } finally {
      setBusy(null);
    }
  }

  /**
   * Hand the browser to Shopify's authorize page.
   *
   * A full-page navigation gives no feedback of its own — on a slow hop the
   * button simply sits there and the page looks dead, so people press it again
   * and land on "the install attempt expired", which describes the FIRST
   * attempt's cookie and explains nothing. The busy state and the line below it
   * are the only things that say the click was heard.
   */
  function startInstall(rawDomain: string) {
    const domain = normalizeShopDomain(rawDomain);
    if (!domain) {
      // Say so inline. Passing it through meant the install route answered with
      // a raw 400 JSON page on the first screen a merchant uses.
      setNotice({
        tone: "negative",
        text: "That doesn't look like a Shopify store address. Paste your admin URL, or type just the store handle.",
      });
      return;
    }
    setBusy("install");
    setNotice({ tone: "positive", text: `Taking you to ${domain} to approve access…` });
    window.location.assign(`/api/shopify/install?shop=${encodeURIComponent(domain)}`);
  }

  function connect() {
    startInstall(shop);
  }

  async function connectWithToken() {
    setBusy("token");
    setNotice(null);
    try {
      const domain = normalizeShopDomain(tokenShop);
      if (!domain) {
        setNotice({
          tone: "negative",
          text: "That doesn't look like a Shopify store address. Paste your admin URL, or type just the store handle.",
        });
        return;
      }
      const res = await connectShopifyWithToken({ shopDomain: domain, accessToken: token });
      if (res.ok) {
        // Clear it the moment it is stored — no reason for a bearer credential
        // to sit in a form field for the rest of the session.
        setToken("");
        setQueued(true);
        setQueueAttempt((n) => n + 1);
        setNotice({ tone: "positive", text: res.message });
        router.refresh();
      } else {
        setNotice({ tone: "negative", text: res.error });
      }
    } catch {
      setNotice({ tone: "negative", text: "Could not connect the store." });
    } finally {
      setBusy(null);
    }
  }

  async function saveCredentials() {
    setBusy("creds");
    setNotice(null);
    try {
      const res = await saveShopifyAppCredentials({ clientId, apiSecret });
      if (res.ok) {
        // The secret is stored; keeping it in a form field afterwards only
        // creates somewhere for it to be read from.
        setApiSecret("");
        setNotice({ tone: "positive", text: res.message });
        router.refresh();
      } else {
        setNotice({ tone: "negative", text: res.error });
      }
    } catch {
      setNotice({ tone: "negative", text: "Could not save the credentials." });
    } finally {
      setBusy(null);
    }
  }

  /** Disconnect pauses; this erases the link so the store stops being this
   *  workspace's, and the domain is free for another one. */
  async function removeStore() {
    const ok = await confirm({
      title: `Remove ${connection?.shopDomain ?? "this store"} from this workspace`,
      body: "The connection, its token and its sync history go. Your products and sales history stay, so the forecast keeps working. You can connect a different store afterwards.",
      confirmLabel: "Remove store",
    });
    if (!ok) return;
    setBusy("remove");
    setNotice(null);
    try {
      const res = await removeShopifyStore();
      if (res.ok) {
        setShop("");
        setTokenShop("");
        setToken("");
        setNotice({ tone: "positive", text: res.message });
        router.refresh();
      } else {
        setNotice({ tone: "negative", text: res.error });
      }
    } finally {
      setBusy(null);
    }
  }

  async function clearCredentials() {
    const ok = await confirm({
      title: "Remove this app's credentials",
      body: "The secret is not recoverable — reconnecting later means creating a new one in the Shopify Partner dashboard.",
      confirmLabel: "Remove credentials",
    });
    if (!ok) return;
    setBusy("clearCreds");
    setNotice(null);
    try {
      const res = await clearShopifyAppCredentials();
      setNotice(
        res.ok ? { tone: "positive", text: res.message } : { tone: "negative", text: res.error }
      );
      if (res.ok) {
        setClientId("");
        setApiSecret("");
        router.refresh();
      }
    } catch {
      setNotice({ tone: "negative", text: "Could not remove the credentials." });
    } finally {
      setBusy(null);
    }
  }

  async function testConnection() {
    setBusy("test");
    setNotice(null);
    try {
      const res = await testShopifyConnection();
      setNotice(
        res.ok ? { tone: "positive", text: res.message } : { tone: "negative", text: res.error }
      );
    } catch {
      setNotice({ tone: "negative", text: "Could not test the connection." });
    } finally {
      setBusy(null);
    }
  }

  /**
   * Connecting with a token the shop generates itself.
   *
   * Rendered for a store that has never connected AND for one that is
   * connected but broken. That second case is the one that matters: when our
   * OAuth install cannot complete — a draft listing, an unregistered app, a
   * revoked token — "Reconnect" sends someone in a circle, and this is the only
   * route back that does not depend on our app at all. Hiding it behind
   * "no connection yet" made it unreachable exactly when it was needed.
   */
  /** Connecting for the first time, so the route tabs are on screen and the
   *  credentials box belongs to its own tab rather than above them. */
  const choosingRoute = connection === null && canManage;

  const tokenConnectPanel = (
    <div id={TOKEN_PANEL_ID} className="scroll-mt-4 space-y-3 border-t border-edge pt-4">
      <div>
        <h3 className="text-sm font-medium text-ink">
          {connection === null
            ? "Create an app in your store admin"
            : "Create an app in your store admin instead"}
        </h3>
        <p className="mt-1 text-sm text-ink-muted">
          In your Shopify admin, go to Settings → Apps and sales channels → Develop
          apps, create an app with the {REQUIRED_SCOPE_LABEL} scopes, install it,
          then paste its Admin API access token here.
          {connection !== null && " This replaces the current connection."}
        </p>
        {/* Shopify's expiring-token rules land on PUBLIC apps — public apps
            created from 1 Apr 2026, and all public apps from 1 Jan 2027. An app
            a merchant makes in their own admin is explicitly excluded, so the
            token pasted here does not expire. Said out loud because the rule is
            easy to read as applying to everything, and someone reasonably
            assumed it did. */}
        <p className="mt-1 text-xs text-ink-faint">
          An app you create in your own store admin is a custom app, so its token
          does not expire. Shopify&apos;s expiring-token rules apply to public
          apps listed on the App Store, not to this one.
        </p>
      </div>
      <div className="grid gap-2 sm:max-w-md">
        <Input
          value={tokenShop}
          onChange={(e) => setTokenShop(e.target.value)}
          placeholder="your-store.myshopify.com"
          aria-label="Store address"
          autoComplete="off"
          name="shopify-token-shop"
        />
        {/* Masked by default — it is a bearer credential and this screen gets
            shared over someone's shoulder — but revealable, because a mistyped
            token is otherwise invisible until the connection fails. */}
        <PasswordInput
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="shpat_…"
          aria-label="Admin API access token"
          autoComplete="new-password"
          name="shopify-admin-token"
        />
        <div>
          <Button
            onClick={connectWithToken}
            loading={busy === "token"}
            disabled={busy !== null || !tokenShop.trim() || !token.trim()}
          >
            Connect with token
          </Button>
        </div>
      </div>
    </div>
  );

  /** The Partner-app route. Its own tab now: on one page with the token
   *  field it read as an extra step rather than an alternative, and filling
   *  both is the combination the worker silently resolves in this one's
   *  favour. */
  const appCredentialsPanel = (
    <div className="space-y-3 rounded-md border border-edge p-3">
      <div>
        <h3 className="text-sm font-medium text-ink">
          Your Shopify app{" "}
          {appCredentialsConfigured ? (
            <Badge tone="positive">Configured</Badge>
          ) : (
            <Badge tone="neutral">Not set</Badge>
          )}
        </h3>
        <p className="mt-1 text-sm text-ink-muted">
          {/* Shopify's rule, not ours: the client-credentials grant works only
              when the app and the store belong to the SAME Shopify
              organisation. These credentials are the shop's own app, not ours —
              nothing here is shared — but a LIVE shop is not in any Dev
              Dashboard organisation, so it is refused whoever owns the app.
              Only development stores created in that dashboard qualify.
              Installing does not change it: install grants permission on a
              shop, this grant asks whether the shop is one of yours. */}
          <strong className="font-medium text-ink">
            Only works if the store is a development store in the same Shopify
            organisation as the app.
          </strong>{" "}
          A live shop is not, so Shopify refuses this route for it — even after
          the app is installed. Use the Admin API token instead.{" "}
          <strong className="font-medium text-ink">
            Do not fill these in as well as pasting a token
          </strong>{" "}
          — when both are present these win, and the token is ignored. We
          never show the secret again once it is saved.
        </p>
      </div>
      <div className="grid gap-2 sm:max-w-md">
        {/* autoComplete off throughout: a bare text + password pair in a
            settings form is exactly what a browser offers to fill with the
            saved sign-in, which silently puts an email in the client ID. */}
        <Input
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder="Client ID"
          aria-label="Shopify app client ID"
          autoComplete="off"
          name="shopify-client-id"
        />
        {/* Same reveal control as the sign-in field: these are long
            opaque strings and a silent typo is otherwise only discovered
            by a failed connection. */}
        <PasswordInput
          value={apiSecret}
          onChange={(e) => setApiSecret(e.target.value)}
          placeholder={appCredentialsConfigured ? "•••••••• (unchanged)" : "API secret key"}
          aria-label="Shopify app API secret"
          autoComplete="new-password"
          name="shopify-api-secret"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={saveCredentials}
            loading={busy === "creds"}
            // A configured workspace may change just the client id; the
            // stored secret is kept when the box is left blank.
            disabled={
              busy !== null ||
              !clientId.trim() ||
              (!apiSecret.trim() && !appCredentialsConfigured)
            }
          >
            {appCredentialsConfigured ? "Update credentials" : "Save credentials"}
          </Button>
          {appCredentialsConfigured && (
            <Button
              variant="ghost"
              onClick={clearCredentials}
              loading={busy === "clearCreds"}
              disabled={busy !== null}
            >
              Remove
            </Button>
          )}
        </div>
      </div>
    </div>
  );

  /** A store that has never connected chooses one route; a connected one keeps
   *  its credential box on the page, because changing an app's secret is a
   *  maintenance job rather than a way in. */

  const routeTabs = (
    <div role="tablist" aria-label="How to connect" className="flex flex-wrap gap-1 rounded-md bg-surface-2 p-1">
      {(
        [
          ["token", "Admin API token"],
          ["install", "Install link"],
          ["credentials", "Client ID & secret (dev stores)"],
        ] as const
      ).map(([key, label]) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={route === key}
          onClick={() => setRoute(key)}
          className={cn(
            "rounded px-3 py-1.5 text-sm font-medium transition-colors",
            route === key ? "bg-surface text-ink shadow-sm" : "text-ink-muted hover:text-ink",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );

  const noticeTone = {
    positive: "bg-positive-soft text-positive",
    warning: "bg-warning-soft text-warning",
    negative: "bg-negative-soft text-negative",
  } as const;

  /**
   * The card's one notice, rendered where it can be read.
   *
   * It lived only at the top of the card, and the action buttons are the last
   * thing in it — around 680px below on a connected store. Pressing "Test
   * connection" in a normal viewport put the answer off screen above, and
   * inserting it shifted the buttons DOWN, so the only visible effect of the
   * press was the control moving. Reported, reasonably, as a button that does
   * nothing at all.
   */
  const noticeBlock = notice && (
    <p className={`rounded-md px-3 py-2 text-sm ${noticeTone[notice.tone]}`} role="status">
      {notice.text}
    </p>
  );

  return (
    <Card>
      <CardHeader
        title="Shopify"
        subtitle="Products, locations, inventory, and sales history"
        action={
          connection === null ? (
            <Badge tone="neutral">Not connected</Badge>
          ) : !live ? (
            <Badge tone="warning">Disconnected</Badge>
          ) : paused ? (
            // Ahead of "Sync failed": both are true, but only one says what to do.
            <Badge tone="warning">Reconnect required</Badge>
          ) : connection.lastAuthError ? (
            // Ahead of "Syncing" too. A queued run does not mean a working one:
            // after a refusal there is always a sync waiting, and it will fail
            // for the same reason. Showing "Syncing" over a refusal banner is
            // how a store sat on "the first sync is running" for a whole day.
            // Safe to lead with, because a successful run clears this
            // (clearAuthFailureState) and so does a reconnect.
            <Badge tone="warning">Needs attention</Badge>
          ) : syncing ? (
            <Badge tone="accent">Syncing</Badge>
          ) : syncRun?.status === "failed" ? (
            <Badge tone="negative">Sync failed</Badge>
          ) : syncRun?.status === "stalled" ? (
            <Badge tone="warning">Sync may have stopped</Badge>
          ) : (
            <Badge tone="positive">Connected</Badge>
          )
        }
      />
      <CardContent className="space-y-4">
        {noticeBlock}

        {canManage && !choosingRoute && appCredentialsPanel}

        {connection === null ? (
          canManage ? (
            <div className="space-y-5">
              <p className="text-sm text-ink-muted">
                Connect your store to pull the catalog, stock levels, and sales
                history that drive restock suggestions.
              </p>

              {routeTabs}

              {route === "install" && (
                <div className="space-y-3">
                  <div>
                    <h3 className="text-sm font-medium text-ink">
                      Install it on your store
                    </h3>
                    <p className="mt-1 text-sm text-ink-muted">
                      {appCredentialsConfigured
                        ? "Enter your store address and we’ll send you to Shopify to approve the install."
                        : "This route uses your app’s client ID and secret. Add them first and come back."}
                    </p>
                    <p className="mt-1 text-xs text-ink-faint">
                      {/* One expression on purpose: JSX drops the space at
                          every text/expression boundary here, which shipped
                          "read_ordersscopes" to the screen. */}
                      {`Your app needs the ${REQUIRED_SCOPE_LABEL} scopes, and its distribution must be set up for this exact store — one app covers one store. If Shopify will not install it, or it installs and syncs still fail, use an Admin API token instead.`}
                    </p>
                  </div>
                  {appCredentialsConfigured ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        value={shop}
                        onChange={(e) => setShop(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && connect()}
                        placeholder="your-store.myshopify.com"
                        className="max-w-xs"
                        aria-label="Shop domain"
                        autoComplete="off"
                        name="shopify-install-shop"
                      />
                      <Button
                        onClick={connect}
                        loading={busy === "install"}
                        disabled={busy !== null || !shop.trim()}
                      >
                        Connect store
                      </Button>
                    </div>
                  ) : (
                    <Button variant="ghost" onClick={() => setRoute("credentials")}>
                      Add client ID &amp; secret
                    </Button>
                  )}
                </div>
              )}

              {route === "credentials" && appCredentialsPanel}

              {route === "token" && tokenConnectPanel}
            </div>
          ) : (
            <p className="text-sm text-ink-muted">
              No store connected yet. Ask a workspace owner or admin to connect one.
            </p>
          )
        ) : (
          <div className="space-y-4">
            {/* Not gated on `paused`: the point is to say something on the
                first failure, not the third. */}
            {!paused && connection.lastAuthError && (
              <p className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
                Shopify refused our last attempt
                {connection.lastAuthErrorAt ? ` (${connection.lastAuthErrorAt})` : ""} —{" "}
                {connection.lastAuthError}{" "}
                {canReinstall
                  ? "Reconnect the store, or check the app is installed on it."
                  : "Paste a fresh token below."}
              </p>
            )}
            {paused && (
              <p className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
                Automatic syncs are paused — the store kept refusing our access token.{" "}
                {canReinstall
                  ? "Reconnect the store to resume."
                  : "Paste a fresh token below to resume."}{" "}
                Stock and sales figures below are from the last sync that worked.
              </p>
            )}
            <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
              <div className="flex items-baseline justify-between gap-4 sm:block">
                <dt className="text-ink-muted">Store</dt>
                <dd className="font-medium text-ink">{connection.shopDomain}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 sm:block">
                <dt className="text-ink-muted">{live ? "Connected since" : "Disconnected"}</dt>
                <dd className="font-medium text-ink">
                  {live ? connection.installedAt : (connection.uninstalledAt ?? "—")}
                </dd>
              </div>
            </dl>

            <SyncProgress
              initialRun={syncRun}
              queued={queued}
              queueAttempt={queueAttempt}
              onActiveChange={onActiveChange}
              onSettled={onSettled}
            />

            <div>
              <h3 className="text-sm font-medium text-ink">Last sync</h3>
              <ul className="mt-1.5 divide-y divide-edge rounded-md border border-edge">
                {lastSync.map((row) => (
                  <li key={row.resource} className="flex items-center justify-between px-3 py-2 text-sm">
                    <span className="capitalize text-ink-secondary">{row.resource}</span>
                    <span className={row.syncedAt ? "text-ink" : "text-ink-muted"}>
                      {row.syncedAt ?? "never"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Repeated here on purpose: this is the row the buttons are in, and
                a result nobody can see is the same as no result. */}
            {noticeBlock}

            <div className="flex flex-wrap items-center gap-2">
              {live && (
                <Button
                  onClick={syncNow}
                  loading={busy === "sync"}
                  disabled={busy !== null || syncing}
                >
                  {syncRun?.status === "failed" || syncRun?.status === "stalled"
                    ? "Retry sync"
                    : "Sync now"}
                </Button>
              )}
              {canManage && live && (
                <Button
                  variant="ghost"
                  onClick={testConnection}
                  loading={busy === "test"}
                  disabled={busy !== null}
                >
                  Test connection
                </Button>
              )}
              {/* Live updates need a websocket the deployment does not have a
                  domain for yet, so this page cannot push its own changes. A
                  button that re-reads the server beats a status line that
                  quietly goes stale and reads as "still running". */}
              {live && (
                <Button
                  variant="ghost"
                  onClick={() => router.refresh()}
                  disabled={busy !== null}
                >
                  Refresh
                </Button>
              )}
              {canManage && live && (
                <Button
                  variant="ghost"
                  onClick={disconnect}
                  loading={busy === "disconnect"}
                  disabled={busy !== null}
                >
                  Disconnect
                </Button>
              )}
              {canManage && (
                <Button
                  variant="ghost"
                  onClick={removeStore}
                  loading={busy === "remove"}
                  disabled={busy !== null}
                >
                  Remove store
                </Button>
              )}
              {/* The way back matches the way in: a store that installed our
                  app reinstalls it, a store that pasted a token pastes another.
                  The stored domain is already normalised, so the install link
                  needs no validating detour. */}
              {canManage &&
                (!live || paused) &&
                (canReinstall ? (
                  <a
                    className={RECOVERY_LINK_CLASS}
                    href={`/api/shopify/install?shop=${encodeURIComponent(connection.shopDomain)}`}
                    // A full-page hop to Shopify shows nothing for a second or
                    // two, and a second press lands on "that install link had
                    // gone stale" — which describes the FIRST press.
                    onClick={() =>
                      setNotice({
                        tone: "positive",
                        text: `Taking you to ${connection.shopDomain} to approve access…`,
                      })
                    }
                  >
                    Reconnect
                  </a>
                ) : (
                  <a className={RECOVERY_LINK_CLASS} href={`#${TOKEN_PANEL_ID}`}>
                    Paste a new token
                  </a>
                ))}
            </div>

            {/* A store that cannot sync needs a way back that does not depend on
                our app completing an install. Shown only when something is
                actually wrong, so a healthy connection is not invited to swap
                its credentials for no reason. */}
            {canManage && (!live || paused) && tokenConnectPanel}
          </div>
        )}
      </CardContent>
      {dialog}
    </Card>
  );
}
