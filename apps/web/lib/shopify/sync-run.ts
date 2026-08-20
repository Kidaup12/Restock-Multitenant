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

/**
 * "5,310 products updated · 3 locations · 812 new sales days" from the
 * accumulated counts.
 *
 * Products and sales days are DELTAS: the pull is incremental once a cursor
 * exists, so a run that finds nothing changed reports zero of each. Printed as
 * bare numbers that read as a sync that did nothing — "0 products · 5 locations
 * · 0 sales days · took 2m 44s" is what a shop would report as a bug, on a run
 * that behaved perfectly. Locations are not a delta; they are pulled in full
 * every time, which is the other half of why the line was unreadable.
 */
export function summarise(counts: unknown): string | null {
  if (!counts || typeof counts !== "object") return null;
  const c = counts as Record<string, Record<string, number> | undefined>;
  const products = c.products?.written;
  const salesDays = c.orders?.salesDays;
  const locations = c.inventory?.locations;
  const failures = c.products?.failed;

  const knownDeltas = [products, salesDays].filter((n) => typeof n === "number") as number[];
  const nothingChanged = knownDeltas.length > 0 && knownDeltas.every((n) => n === 0);

  const parts: string[] = [];
  if (nothingChanged) {
    parts.push("no changes since the last sync");
  } else {
    if (typeof products === "number") parts.push(`${plural(products, "product")} updated`);
    if (typeof salesDays === "number") parts.push(`${plural(salesDays, "new sales day")}`);
  }
  if (typeof failures === "number" && failures > 0) parts.push(plural(failures, "failure"));
  if (typeof locations === "number") parts.push(plural(locations, "location"));
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
