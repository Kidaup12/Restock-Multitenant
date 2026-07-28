import type { Redis } from "ioredis";
import { prismaService } from "@wezesha/db";
import { publishEvent } from "@wezesha/realtime";

/**
 * Progress reporting for one sync attempt.
 *
 * Owns both halves of every signal — the SyncRun row and the realtime event —
 * so the durable record and the wire can never drift apart. The row is the
 * truth: a screen loaded cold mid-run reads it and is correct with no socket at
 * all. The event only saves a client a refetch.
 *
 * Nothing here may fail a sync. Every write is best-effort, because a progress
 * report that throws would turn a working sync into a failed one — strictly
 * worse than a stale progress bar.
 */

/** Minimum gap between intra-phase ticks. Phase edges and terminal states are
 *  never throttled, so a two-variant fixture still emits deterministically
 *  while a five-thousand-SKU catalogue costs a handful of publishes. */
const TICK_INTERVAL_MS = 1000;

/** Long enough to name the cause, short enough that a runaway message can't
 *  bloat the row. */
const ERROR_MAX = 500;

type Phases = readonly string[];

export class SyncRunReporter {
  private id: string | null = null;
  private phase: string | null = null;
  private phaseIndex = 0;
  private itemsTotal: number | null = null;
  private lastTickAt = 0;
  private readonly counts: Record<string, unknown> = {};

  private constructor(
    private readonly publisher: Redis,
    private readonly tenantId: string,
    private readonly source: string,
    private readonly phases: Phases
  ) {}

  /** Create the row at processor entry — one row per ATTEMPT, so a retry after a
   *  backoff is a separate, separately-readable fact. */
  static async open(opts: {
    publisher: Redis;
    tenantId: string;
    source: string;
    phases: Phases;
    attempt: number;
  }): Promise<SyncRunReporter> {
    const reporter = new SyncRunReporter(opts.publisher, opts.tenantId, opts.source, opts.phases);
    try {
      const row = await prismaService.syncRun.create({
        data: {
          tenantId: opts.tenantId,
          source: opts.source,
          status: "running",
          attempt: opts.attempt,
          phaseTotal: opts.phases.length,
        },
        select: { id: true },
      });
      reporter.id = row.id;
    } catch (err) {
      console.error(`worker: could not open a sync run for ${opts.tenantId}`, err);
    }
    return reporter;
  }

  /** Entering a phase. `itemsTotal` is omitted when the count isn't knowable yet
   *  — the Shopify fetch hasn't returned — and the UI shows an indeterminate bar
   *  rather than a made-up denominator. */
  async phaseStart(phase: string, itemsTotal?: number): Promise<void> {
    this.phase = phase;
    this.phaseIndex = this.phases.indexOf(phase) + 1;
    this.itemsTotal = itemsTotal ?? null;
    this.lastTickAt = 0;
    await this.write({
      phase,
      phaseIndex: this.phaseIndex,
      itemsDone: 0,
      itemsTotal: this.itemsTotal,
    });
    await this.emit("started", 0);
  }

  /** Progress inside the current phase. Throttled, except for the first tick. */
  async tick(itemsDone: number, itemsTotal?: number): Promise<void> {
    if (itemsTotal !== undefined) this.itemsTotal = itemsTotal;
    const now = Date.now();
    const first = this.lastTickAt === 0;
    if (!first && now - this.lastTickAt < TICK_INTERVAL_MS) return;
    this.lastTickAt = now;
    await this.write({ itemsDone, itemsTotal: this.itemsTotal });
    await this.emit("running", itemsDone);
  }

  /** Leaving a phase. The event this publishes is field-for-field what the
   *  phase-completion event has always been, so older subscribers are unaffected. */
  async phaseEnd(phase: string, counts: Record<string, unknown>): Promise<void> {
    this.counts[phase] = counts;
    await this.write({ counts: this.counts });
    await this.emit("finished", this.itemsTotal ?? 0, this.phases.indexOf(phase) + 1);
  }

  async ok(): Promise<void> {
    await this.write({ status: "ok", finishedAt: new Date(), phase: null });
    await this.done(true);
  }

  async fail(err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    await this.write({
      status: "failed",
      error: message.slice(0, ERROR_MAX),
      finishedAt: new Date(),
    });
    // `sync.done` on failure is published by the final-failure hook, which knows
    // whether a retry is still coming. Closing the row here only makes sure no
    // attempt is left reading as "running" forever.
  }

  private async done(ok: boolean): Promise<void> {
    await this.publish({
      type: "sync.done",
      data: { tenantId: this.tenantId, source: this.source, ok, ...(this.id ? { runId: this.id } : {}) },
    });
  }

  private async emit(
    state: "started" | "running" | "finished",
    items: number,
    doneOverride?: number
  ): Promise<void> {
    if (!this.phase) return;
    await this.publish({
      type: "sync.progress",
      data: {
        tenantId: this.tenantId,
        source: this.source,
        phase: this.phase,
        // Phases COMPLETED — unchanged meaning, so the legacy shape still reads
        // correctly for anything subscribing from before the widening.
        done: doneOverride ?? this.phaseIndex - 1,
        total: this.phases.length,
        state,
        items,
        ...(this.itemsTotal != null ? { itemsTotal: this.itemsTotal } : {}),
        ...(this.id ? { runId: this.id } : {}),
      },
    });
  }

  private async write(data: Record<string, unknown>): Promise<void> {
    if (!this.id) return;
    try {
      await prismaService.syncRun.update({ where: { id: this.id }, data });
    } catch (err) {
      console.error(`worker: could not update sync run ${this.id}`, err);
    }
  }

  private async publish(event: Parameters<typeof publishEvent>[1]): Promise<void> {
    try {
      await publishEvent(this.publisher, event);
    } catch (err) {
      console.error(`worker: could not publish ${event.type} for ${this.tenantId}`, err);
    }
  }
}
