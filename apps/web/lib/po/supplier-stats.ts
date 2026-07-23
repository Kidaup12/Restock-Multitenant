/**
 * Supplier performance math, derived from PO history at read time.
 *
 * Deliberately NO running tally columns on Supplier (onTimeCount, orderedUnits,
 * …): tallies are a cache with no invalidation story — an un-receive, a PO
 * soft-delete or a correction would need compensating decrements that are easy
 * to miss, and a drifted score is worse than none. A tenant has tens of
 * suppliers and each a few hundred POs at most, so deriving from the rows the
 * scores claim to describe costs microseconds and is always right.
 *
 * The one materialised value is Supplier.leadTimeAvgDays/StdDays — the
 * forecast engine reads those columns directly — and even that is recomputed
 * from the full receipt history on every completed delivery, never
 * incrementally tallied.
 */

const DAY_MS = 86_400_000;

/** A PO's score-relevant slice. Only sent POs enter scoring. */
export type ScorablePo = {
  sentAt: Date | null;
  expectedAt: Date | null;
  /** Set when every line is fully received (delivery complete). */
  receivedAt: Date | null;
  lines: { quantity: number; receivedQty: number }[];
};

export type SupplierScore = {
  /** Sent POs that have at least one receipt. */
  deliveredPos: number;
  /** received-on-or-before-expectedAt share of completed POs with an ETA. null = no data. */
  onTimePct: number | null;
  /** sum(receivedQty) / sum(quantity) across POs with any receipt. null = no data. */
  fillRatePct: number | null;
  /** Mean actual lead time (days) over completed deliveries. null = no data. */
  learnedLeadDays: number | null;
};

/** Whole days between send and receipt, minimum 0. */
export function actualLeadDays(sentAt: Date, receivedAt: Date): number {
  return Math.max(0, Math.round((receivedAt.getTime() - sentAt.getTime()) / DAY_MS));
}

/** Mean + sample standard deviation of actual lead times. std is null below
 *  two samples — a one-delivery "spread" would just erase the configured
 *  default with noise. */
export function leadTimeStats(samples: number[]): { avg: number; std: number | null } | null {
  if (samples.length === 0) return null;
  const avg = samples.reduce((s, d) => s + d, 0) / samples.length;
  if (samples.length < 2) return { avg: Math.round(avg), std: null };
  const variance =
    samples.reduce((s, d) => s + (d - avg) ** 2, 0) / (samples.length - 1);
  return { avg: Math.round(avg), std: Math.round(Math.sqrt(variance)) };
}

export function computeSupplierScore(pos: ScorablePo[]): SupplierScore {
  let orderedUnits = 0;
  let receivedUnits = 0;
  let deliveredPos = 0;
  let etaJudged = 0;
  let onTime = 0;
  const leadSamples: number[] = [];

  for (const po of pos) {
    if (!po.sentAt) continue; // never sent — nothing was promised
    const anyReceipt = po.lines.some((l) => l.receivedQty > 0);
    if (anyReceipt) {
      deliveredPos += 1;
      for (const l of po.lines) {
        orderedUnits += l.quantity;
        receivedUnits += Math.min(l.receivedQty, l.quantity);
      }
    }
    if (po.receivedAt) {
      leadSamples.push(actualLeadDays(po.sentAt, po.receivedAt));
      if (po.expectedAt) {
        etaJudged += 1;
        if (po.receivedAt.getTime() <= po.expectedAt.getTime()) onTime += 1;
      }
    }
  }

  const lead = leadTimeStats(leadSamples);
  return {
    deliveredPos,
    onTimePct: etaJudged > 0 ? Math.round((onTime / etaJudged) * 100) : null,
    fillRatePct: orderedUnits > 0 ? Math.round((receivedUnits / orderedUnits) * 100) : null,
    learnedLeadDays: lead ? lead.avg : null,
  };
}
