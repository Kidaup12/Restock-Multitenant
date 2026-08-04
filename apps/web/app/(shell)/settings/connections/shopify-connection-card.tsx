"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { SyncRunView } from "@/lib/shopify/sync-run";
import { connectShopifyWithToken } from "./actions";
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
};

type LastSyncRow = { resource: string; syncedAt: string | null };

const OAUTH_ERRORS: Record<string, string> = {
  forbidden: "Only owners and admins can connect a store.",
  invalid_state: "The install attempt expired or was tampered with. Try again.",
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
}: {
  connection: ConnectionView | null;
  lastSync: LastSyncRow[];
  canManage: boolean;
  justConnected: boolean;
  errorCode: string | null;
  syncRun: SyncRunView | null;
}) {
  const router = useRouter();
  const [shop, setShop] = useState("");
  const [tokenShop, setTokenShop] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<"sync" | "disconnect" | "token" | null>(null);
  // Covers the gap between the queue accepting the job and the worker opening
  // its row — the one moment a run exists but nothing durable says so.
  const [queued, setQueued] = useState(justConnected);
  const [queueAttempt, setQueueAttempt] = useState(justConnected ? 1 : 0);
  // Whether a sync is actually in flight. It has to come from the progress
  // component: syncRun is a server render and does not move while a sync runs,
  // so deriving the button state from it would leave "Sync now" disabled until
  // the next full page load.
  const [syncActive, setSyncActive] = useState(syncRun?.status === "running");
  const [notice, setNotice] = useState<{ tone: "positive" | "warning" | "negative"; text: string } | null>(
    errorCode
      ? { tone: "negative", text: OAUTH_ERRORS[errorCode] ?? "Connecting the store failed." }
      : justConnected
        ? { tone: "positive", text: "Store connected. The first sync is running in the background." }
        : null
  );

  const live = connection !== null && connection.uninstalledAt === null;
  // Still installed as far as the app knows, but every request is being refused.
  const paused = live && connection.syncPausedAt !== null;
  const syncing = syncActive;
  const onActiveChange = useCallback((value: boolean) => setSyncActive(value), []);
  const onSettled = useCallback(() => setQueued(false), []);

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
    setBusy("disconnect");
    setNotice(null);
    try {
      const res = await fetch("/api/shopify/disconnect", { method: "POST" });
      if (res.ok) {
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

  function connect() {
    const cleaned = shop.trim().toLowerCase();
    if (!cleaned) return;
    const domain = cleaned.includes(".") ? cleaned : `${cleaned}.myshopify.com`;
    window.location.assign(`/api/shopify/install?shop=${encodeURIComponent(domain)}`);
  }

  async function connectWithToken() {
    setBusy("token");
    setNotice(null);
    try {
      const cleaned = tokenShop.trim().toLowerCase();
      const domain = cleaned.includes(".") ? cleaned : `${cleaned}.myshopify.com`;
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

  const noticeTone = {
    positive: "bg-positive-soft text-positive",
    warning: "bg-warning-soft text-warning",
    negative: "bg-negative-soft text-negative",
  } as const;

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
          ) : syncing ? (
            <Badge tone="accent">Syncing</Badge>
          ) : paused ? (
            // Ahead of "Sync failed": both are true, but only one says what to do.
            <Badge tone="warning">Reconnect required</Badge>
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
        {notice && (
          <p className={`rounded-md px-3 py-2 text-sm ${noticeTone[notice.tone]}`}>{notice.text}</p>
        )}

        {connection === null ? (
          canManage ? (
            <div className="space-y-5">
              <div className="space-y-3">
                <p className="text-sm text-ink-muted">
                  Connect your store to pull the catalog, stock levels, and sales
                  history that drive restock suggestions.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    value={shop}
                    onChange={(e) => setShop(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && connect()}
                    placeholder="your-store.myshopify.com"
                    className="max-w-xs"
                    aria-label="Shop domain"
                  />
                  <Button onClick={connect} disabled={!shop.trim()}>
                    Connect store
                  </Button>
                </div>
              </div>

              <div className="space-y-3 border-t border-edge pt-4">
                <div>
                  <h3 className="text-sm font-medium text-ink">
                    Or connect with your own app
                  </h3>
                  <p className="mt-1 text-sm text-ink-muted">
                    In your Shopify admin, go to Settings → Apps and sales channels
                    → Develop apps, create an app with the {REQUIRED_SCOPE_LABEL}{" "}
                    scopes, install it, then paste its Admin API access token here.
                  </p>
                </div>
                <div className="grid gap-2 sm:max-w-md">
                  <Input
                    value={tokenShop}
                    onChange={(e) => setTokenShop(e.target.value)}
                    placeholder="your-store.myshopify.com"
                    aria-label="Store address"
                  />
                  <Input
                    // Treated as a password: it is a bearer credential, and this
                    // screen gets shared over someone's shoulder.
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="shpat_…"
                    aria-label="Admin API access token"
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
            </div>
          ) : (
            <p className="text-sm text-ink-muted">
              No store connected yet. Ask a workspace owner or admin to connect one.
            </p>
          )
        ) : (
          <div className="space-y-4">
            {paused && (
              <p className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
                Automatic syncs are paused — the store kept refusing our access token.
                Reconnect the store to resume. Stock and sales figures below are from
                the last sync that worked.
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
                  onClick={disconnect}
                  loading={busy === "disconnect"}
                  disabled={busy !== null}
                >
                  Disconnect
                </Button>
              )}
              {canManage && (!live || paused) && (
                <Button
                  onClick={() =>
                    window.location.assign(
                      `/api/shopify/install?shop=${encodeURIComponent(connection.shopDomain)}`
                    )
                  }
                >
                  Reconnect
                </Button>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
