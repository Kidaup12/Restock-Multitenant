"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * QuickBooks connection card.
 *
 * Unlike Shopify, where each workspace registers its own app, QuickBooks runs
 * on one platform-wide app — so there is nothing for the owner to paste. The
 * card is a connect button, a status line, and a disconnect.
 */

export type QuickBooksConnectionView = {
  realmId: string;
  connectedAt: string;
  disconnectedAt: string | null;
  syncPausedAt: string | null;
  lastAuthError: string | null;
};

export function QuickBooksConnectionCard({
  connection,
  canManage,
  configured,
  notice,
}: {
  connection: QuickBooksConnectionView | null;
  canManage: boolean;
  /** False when the platform app has no credentials set — connecting cannot work. */
  configured: boolean;
  notice: { kind: "ok" | "error"; text: string } | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const live = connection !== null && connection.disconnectedAt === null;

  async function onDisconnect() {
    setError(null);
    const res = await fetch("/api/quickbooks/disconnect", { method: "POST" });
    if (!res.ok) {
      setError("Could not disconnect. Try again.");
      return;
    }
    const body = (await res.json()) as { revoked?: boolean };
    // Say which of the two happened rather than implying the stronger one.
    if (!body.revoked) {
      setError("Disconnected here, but QuickBooks did not confirm. Check the app in Intuit.");
    }
    startTransition(() => router.refresh());
  }

  return (
    <section className="rounded-lg border border-[var(--border)] p-5 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">QuickBooks</h2>
          <p className="text-sm text-[var(--muted-foreground)]">
            Spots purchase orders raised in QuickBooks, so the buy list does not
            re-order stock that is already on its way.
          </p>
        </div>
        <span
          className={`shrink-0 rounded px-2 py-1 text-xs ${
            live
              ? "bg-emerald-500/10 text-emerald-400"
              : "bg-[var(--muted)] text-[var(--muted-foreground)]"
          }`}
        >
          {live ? "Connected" : "Not connected"}
        </span>
      </div>

      {notice && (
        <p className={`text-sm ${notice.kind === "ok" ? "text-emerald-400" : "text-red-400"}`}>
          {notice.text}
        </p>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}

      {live && connection && (
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt className="text-[var(--muted-foreground)]">Company</dt>
          <dd className="font-mono text-xs">{connection.realmId}</dd>
          <dt className="text-[var(--muted-foreground)]">Connected</dt>
          <dd>{connection.connectedAt}</dd>
          {connection.syncPausedAt && (
            <>
              <dt className="text-[var(--muted-foreground)]">Paused</dt>
              <dd className="text-amber-400">
                {connection.syncPausedAt}
                {connection.lastAuthError ? ` — ${connection.lastAuthError}` : ""}
              </dd>
            </>
          )}
        </dl>
      )}

      {!configured && (
        <p className="text-sm text-amber-400">
          QuickBooks is not set up on this deployment yet. Nothing to do here for now.
        </p>
      )}

      {canManage && configured && (
        <div className="flex gap-3">
          {!live && (
            <a
              href="/api/quickbooks/install"
              className="rounded bg-[var(--accent-600)] px-3 py-2 text-sm font-medium text-white"
            >
              Connect QuickBooks
            </a>
          )}
          {live && (
            <button
              type="button"
              onClick={onDisconnect}
              disabled={pending}
              className="rounded border border-[var(--border)] px-3 py-2 text-sm"
            >
              {pending ? "Disconnecting…" : "Disconnect"}
            </button>
          )}
        </div>
      )}
      {!canManage && (
        <p className="text-sm text-[var(--muted-foreground)]">
          Only owners and admins can change this.
        </p>
      )}
    </section>
  );
}
