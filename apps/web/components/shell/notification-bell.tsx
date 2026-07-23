"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { AlertIcon, BellIcon, BoxIcon, GearIcon } from "@/components/icons";
import { Spinner } from "@/components/ui/spinner";
import { useRealtime, useRealtimeStatus } from "@/lib/realtime/use-realtime";
import { kindTone, relativeTime } from "@/lib/notifications/format";
import type { NotificationItem } from "@/lib/notifications/data";

/**
 * The header bell: unread badge (server-seeded, then live), a dropdown feed,
 * and a connection-status dot. One /api/realtime-token fetch feeds both the
 * notification.new subscription and the status dot; opening the panel loads a
 * page of the feed and marks it read (the "new" styling survives locally so
 * just-arrived items stay visually distinct while the panel is open).
 */

type Connection = { url: string | null; token: string | null };

/** Feed row + whether it was unread when it entered the panel. */
type FeedItem = NotificationItem & { wasUnread: boolean };

type FeedResponse = {
  notifications: NotificationItem[];
  nextCursor: string | null;
  unread: number;
};

const statusMeta = {
  open: { label: "live", dot: "bg-positive" },
  connecting: { label: "reconnecting", dot: "bg-warning" },
  retrying: { label: "reconnecting", dot: "bg-warning" },
  closed: { label: "offline", dot: "bg-ink-faint" },
} as const;

const toneClass = {
  negative: "bg-negative-soft text-negative",
  warning: "bg-warning-soft text-warning",
  neutral: "bg-surface-2 text-ink-muted",
} as const;

function kindIcon(kind: string): React.ReactNode {
  switch (kind) {
    case "sync_failed":
      return <AlertIcon />;
    case "shopify_reconnect":
      return <GearIcon />;
    case "shopify_uninstalled":
      return <BoxIcon />;
    default:
      return <BellIcon />;
  }
}

async function markRead(body: { ids: string[] } | { all: true }): Promise<number> {
  try {
    const res = await fetch("/api/notifications/mark-read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return 0;
    const data = (await res.json()) as { updated?: number };
    return data.updated ?? 0;
  } catch {
    return 0;
  }
}

export function NotificationBell({
  initialUnread,
  workspaceId,
}: {
  initialUnread: number;
  /** Active workspace — a change re-binds the socket and re-seeds the badge
   *  (workspace switches are router.refresh(), which keeps client state). */
  workspaceId: string | null;
}) {
  const [unread, setUnread] = useState(initialUnread);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [connection, setConnection] = useState<Connection>({ url: null, token: null });
  const containerRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  // The token url carries the active workspace, so a workspace change fetches
  // a fresh binding and the hooks swap sockets.
  useEffect(() => {
    let alive = true;
    fetch("/api/realtime-token")
      .then((res) => (res.ok ? (res.json() as Promise<Connection>) : null))
      .then((data) => {
        if (alive && data) setConnection(data);
      })
      .catch(() => {
        // No realtime — the bell still works from the server-rendered count.
      });
    return () => {
      alive = false;
    };
  }, [workspaceId]);

  // Workspace switched without a remount: drop the old feed, re-seed the badge.
  const prevWorkspace = useRef(workspaceId);
  useEffect(() => {
    if (prevWorkspace.current === workspaceId) return;
    prevWorkspace.current = workspaceId;
    setUnread(initialUnread);
    setItems(null);
    setNextCursor(null);
    setOpen(false);
  }, [workspaceId, initialUnread]);

  const status = useRealtimeStatus(connection);
  const meta = statusMeta[status];

  /** Load a feed page; the first page replaces the list and marks it read. */
  const loadFeed = useCallback(async (cursor: string | null) => {
    setLoading(true);
    try {
      const query = new URLSearchParams();
      if (cursor) query.set("cursor", cursor);
      const res = await fetch(`/api/notifications?${query.toString()}`);
      if (!res.ok) return;
      const data = (await res.json()) as FeedResponse;
      const fetched: FeedItem[] = data.notifications.map((n) => ({
        ...n,
        wasUnread: n.readAt === null,
      }));
      setItems((prev) => (cursor && prev ? [...prev, ...fetched] : fetched));
      setNextCursor(data.nextCursor);

      const unreadIds = fetched.filter((n) => n.wasUnread).map((n) => n.id);
      if (unreadIds.length > 0) {
        const updated = await markRead({ ids: unreadIds });
        setUnread(Math.max(0, data.unread - updated));
      } else {
        setUnread(data.unread);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useRealtime(
    {
      "notification.new": () => {
        if (openRef.current) {
          // Panel open: refresh the page so the new item appears (and is
          // marked read like the rest of the visible feed).
          void loadFeed(null);
        } else {
          setUnread((count) => count + 1);
        }
      },
    },
    connection
  );

  // Close on outside pointerdown, matching the profile menu.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) void loadFeed(null);
  }

  async function markAll() {
    await markRead({ all: true });
    setUnread(0);
    setItems((prev) => prev?.map((n) => ({ ...n, wasUnread: false })) ?? prev);
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-label={unread > 0 ? `Notifications (${unread} unread)` : "Notifications"}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cn(
          "relative grid size-9 place-items-center rounded-md border border-edge bg-surface text-ink-secondary transition-colors",
          "outline-accent hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2"
        )}
      >
        <BellIcon className="size-4.5" />
        {unread > 0 && (
          <span className="absolute -top-1.5 -right-1.5 grid h-4.5 min-w-4.5 place-items-center rounded-full bg-negative px-1 text-[10px] font-bold text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {/* Live-connection indicator; deliberately subtle. */}
      <span
        title={`Live updates: ${meta.label}`}
        aria-label={`Live updates: ${meta.label}`}
        role="status"
        className={cn(
          "absolute -bottom-0.5 -left-0.5 size-2 rounded-full ring-2 ring-page",
          meta.dot
        )}
      />

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
          }}
          className="absolute right-0 z-30 mt-2 w-[min(380px,calc(100vw-24px))] rounded-lg border border-edge bg-surface shadow-pop"
        >
          <div className="flex items-center justify-between border-b border-edge px-4 py-2.5">
            <span className="text-sm font-semibold text-ink">Notifications</span>
            {(unread > 0 || (items?.some((n) => n.wasUnread) ?? false)) && (
              <button
                type="button"
                onClick={() => void markAll()}
                className="text-xs font-medium text-accent-ink hover:underline"
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-[min(420px,60vh)] overflow-y-auto p-1.5">
            {items === null ? (
              <div className="grid place-items-center py-10">
                <Spinner size="sm" />
              </div>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center py-10 text-center">
                <div className="grid size-10 place-items-center rounded-md bg-surface-2 text-ink-muted">
                  <BellIcon className="size-5" />
                </div>
                <p className="mt-3 text-sm font-medium text-ink">All caught up</p>
                <p className="mt-0.5 text-xs text-ink-muted">
                  Sync alerts and workspace updates land here.
                </p>
              </div>
            ) : (
              <>
                {items.map((item) => (
                  <div
                    key={item.id}
                    className={cn(
                      "flex gap-3 rounded-md px-2.5 py-2.5",
                      item.wasUnread && "bg-accent-soft/40"
                    )}
                  >
                    <span
                      className={cn(
                        "mt-0.5 grid size-7 shrink-0 place-items-center rounded-md [&_svg]:size-4",
                        toneClass[kindTone(item.kind)]
                      )}
                    >
                      {kindIcon(item.kind)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-sm font-medium text-ink">
                          {item.title}
                        </span>
                        <span className="shrink-0 text-[11px] text-ink-faint">
                          {relativeTime(item.createdAt)}
                        </span>
                      </div>
                      {item.body && (
                        <p className="mt-0.5 line-clamp-2 text-xs text-ink-muted">
                          {item.body}
                        </p>
                      )}
                    </div>
                    {item.wasUnread && (
                      <span
                        aria-hidden="true"
                        className="mt-2 size-1.5 shrink-0 rounded-full bg-accent"
                      />
                    )}
                  </div>
                ))}
                {nextCursor && (
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => void loadFeed(nextCursor)}
                    className={cn(
                      "mt-1 w-full rounded-md py-2 text-center text-xs font-medium text-ink-muted transition-colors",
                      "hover:bg-surface-2 hover:text-ink",
                      loading && "pointer-events-none opacity-60"
                    )}
                  >
                    {loading ? "Loading…" : "Show older"}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
