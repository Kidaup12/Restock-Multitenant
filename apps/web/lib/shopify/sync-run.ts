/**
 * Reading a sync run for the Connections screen.
 *
 * The row is the truth and the realtime event is only an accelerator, so this
 * mapper is what makes a cold page load correct mid-run — with no socket, no
 * polling, and nothing carried over from the tab that started the sync.
 *
 * Kept pure and free of Prisma so the interesting case (a worker that died
 * holding a `running` row) is testable without a database.
 */

/** A run whose row has not been touched for this long is presumed abandoned:
 *  the worker died, and nothing else will ever close it. Well clear of the
 *  gap between two intra-phase ticks. */
export const STALE_AFTER_MS = 10 * 60 * 1000;

export type SyncRunStatus = "running" | "ok" | "failed" | "stalled";

export type SyncRunRow = {
  id: string;
  status: string;
  phase: string | null;
  phaseIndex: number;
  phaseTotal: number;
  itemsDone: number;
  itemsTotal: number | null;
  counts: unknown;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  updatedAt: Date;
};

/** Serializable — the card is a client component, so no Date crosses the seam. */
export type SyncRunView = {
  id: string;
  status: SyncRunStatus;
  phase: string | null;
  phaseIndex: number;
  phaseTotal: number;
  itemsDone: number;
  itemsTotal: number | null;
  /** Human summary of what the run wrote, once it finished. */
  summary: string | null;
  error: string | null;
  finishedAt: string | null;
  /** Whole seconds, for "took 4m 12s". Null while still running. */
  durationSec: number | null;
};

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-KE")} ${n === 1 ? one : many}`;
}

/** "5,310 products · 3 locations · 812 sales days" from the accumulated counts. */
export function summarise(counts: unknown): string | null {
  if (!counts || typeof counts !== "object") return null;
  const c = counts as Record<string, Record<string, number> | undefined>;
  const parts: string[] = [];
  if (typeof c.products?.written === "number") parts.push(plural(c.products.written, "product"));
  if (typeof c.products?.failed === "number" && c.products.failed > 0) {
    parts.push(`${plural(c.products.failed, "failure")}`);
  }
  if (typeof c.inventory?.locations === "number") parts.push(plural(c.inventory.locations, "location"));
  if (typeof c.orders?.salesDays === "number") parts.push(plural(c.orders.salesDays, "sales day"));
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function toSyncRunView(run: SyncRunRow | null, now: Date): SyncRunView | null {
  if (!run) return null;
  const stalled =
    run.status === "running" && now.getTime() - run.updatedAt.getTime() > STALE_AFTER_MS;
  const status: SyncRunStatus = stalled
    ? "stalled"
    : run.status === "ok" || run.status === "failed" || run.status === "running"
      ? run.status
      : "running";
  return {
    id: run.id,
    status,
    phase: run.phase,
    phaseIndex: run.phaseIndex,
    phaseTotal: run.phaseTotal,
    itemsDone: run.itemsDone,
    itemsTotal: run.itemsTotal,
    summary: summarise(run.counts),
    error: run.error,
    finishedAt: run.finishedAt ? `${run.finishedAt.toISOString().slice(0, 16).replace("T", " ")} UTC` : null,
    durationSec: run.finishedAt
      ? Math.max(0, Math.round((run.finishedAt.getTime() - run.startedAt.getTime()) / 1000))
      : null,
  };
}
