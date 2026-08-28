/**
 * Transfer sizing — the pure engine behind "what to move, from where to where".
 *
 * A distribution plan proposes moving stock out of one holding location so every
 * selling location ends on the SAME days of cover at its own run rate. This
 * module is the pure math: given a source's available units and each
 * destination's on-hand + run-rate share, it sizes whole-unit moves that
 * level-fill everyone to a common cover. No I/O, no Prisma — the caller supplies
 * the positions (the web app from its metrics, the worker from its own rollup),
 * so both share ONE sizing engine rather than two that can disagree.
 */

/** At or below this a destination has no measurable velocity — cover is
 *  undefined there, so it receives nothing. */
export const NO_RATE_EPSILON = 0.0001;

/** Target days of cover a plan levels every destination up to. */
export const DEFAULT_COVER_DAYS = 14;
/** Trailing window used to attribute demand to a branch. */
export const DEFAULT_WINDOW_DAYS = 90;
/** Cover horizons offered on the screen. */
export const COVER_DAY_CHOICES = [7, 14, 30] as const;
/** Guard rails for anything a client can influence. */
export const MIN_COVER_DAYS = 1;
export const MAX_COVER_DAYS = 180;
export const MIN_WINDOW_DAYS = 7;
export const MAX_WINDOW_DAYS = 365;

export type DestinationPosition = {
  locationId: string;
  /** On-hand at this destination today. Negative = oversold: a hole to backfill. */
  onHand: number;
  /** This destination's share of the product's run rate (units/day). */
  runRate: number;
};

export type SizedTransfer = {
  toLocationId: string;
  /** Whole units to move. Never fractional, never more than the source holds. */
  qty: number;
  toOnHand: number;
  toRunRate: number;
  toDaysCoverBefore: number;
  toDaysCoverAfter: number;
};

const roundTo1 = (value: number): number => Math.round(value * 10) / 10;

/** Units a destination is short of a given cover level. Negative on-hand raises
 *  the need — the hole is real stock the branch owes its shelf. */
const shortfall = (d: DestinationPosition, level: number): number =>
  Math.max(0, d.runRate * level - d.onHand);

/**
 * The highest common cover level the available units can lift every destination
 * to (the classic level-fill). Exact rather than iterative: each destination
 * starts needing stock at level `onHand / runRate`, so walking those breakpoints
 * in order gives a segment on which the total need is linear in the level, and
 * the level is solved directly on the first segment that fits.
 */
function fillLevel(destinations: DestinationPosition[], available: number): number {
  const points = [...destinations].sort((a, b) => a.onHand / a.runRate - b.onHand / b.runRate);
  let rate = 0;
  let onHand = 0;
  for (let i = 0; i < points.length; i++) {
    rate += points[i]!.runRate;
    onHand += points[i]!.onHand;
    const next = points[i + 1];
    const level = (available + onHand) / rate;
    if (!next || level <= next.onHand / next.runRate) return level;
  }
  return 0; // unreachable: the last segment has no upper breakpoint
}

/**
 * Size one product's move out of a source holding `available` units.
 *
 * The rule: level-fill to a common days-of-cover. Every destination is lifted to
 * the same cover level — the target when the source can afford it, otherwise the
 * highest level the source can reach for everyone. That is what "equalise cover"
 * means; the alternative, splitting the shortfall proportionally, *preserves*
 * the imbalance it is meant to remove (the branch that started emptiest stays
 * emptiest), so it is used only to settle the rounding remainder below.
 *
 * The decisions this encodes, in order:
 *
 * 1. No run rate at a destination (`runRate <= NO_RATE_EPSILON`) → it receives
 *    nothing. There is no cover to equalise, and shipping stock to a branch with
 *    no measured demand manufactures the dead stock the product exists to kill.
 * 2. The source holds none of the product (`available <= 0`) → no lines.
 * 3. Already at or above the level → that destination gets nothing.
 * 4. Source can't satisfy everyone → level-fill (above).
 * 5. Rounding → floor each destination's fractional need, then hand the leftover
 *    whole units out by largest fractional part (ties to the faster seller, then
 *    by location id so the plan is deterministic).
 */
export function sizeTransfers(
  available: number,
  destinations: DestinationPosition[],
  coverDays: number
): SizedTransfer[] {
  const units = Math.floor(Math.max(0, available));
  const candidates = destinations.filter((d) => d.runRate > NO_RATE_EPSILON);
  if (units <= 0 || candidates.length === 0) return [];

  const needAtTarget = candidates.reduce((sum, d) => sum + shortfall(d, coverDays), 0);
  if (needAtTarget <= 0) return [];

  const level = needAtTarget <= units ? coverDays : fillLevel(candidates, units);

  const wants = candidates
    .map((d) => ({ d, want: shortfall(d, level) }))
    .filter((w) => w.want > 0);
  if (wants.length === 0) return [];

  // Float slack on the total only: the level solve lands on sums like 3.999…7,
  // and flooring that raw would silently strand a unit.
  const budget = Math.min(units, Math.floor(wants.reduce((sum, w) => sum + w.want, 0) + 1e-9));
  const qtyByLocation = new Map(wants.map((w) => [w.d.locationId, Math.floor(w.want)]));
  let spare = budget - [...qtyByLocation.values()].reduce((sum, q) => sum + q, 0);

  const byRemainder = [...wants].sort(
    (a, b) =>
      b.want - Math.floor(b.want) - (a.want - Math.floor(a.want)) ||
      b.d.runRate - a.d.runRate ||
      a.d.locationId.localeCompare(b.d.locationId)
  );
  for (const w of byRemainder) {
    if (spare <= 0) break;
    qtyByLocation.set(w.d.locationId, (qtyByLocation.get(w.d.locationId) ?? 0) + 1);
    spare -= 1;
  }

  return wants
    .map(({ d }) => {
      const qty = qtyByLocation.get(d.locationId) ?? 0;
      return {
        toLocationId: d.locationId,
        qty,
        toOnHand: d.onHand,
        toRunRate: d.runRate,
        toDaysCoverBefore: roundTo1(Math.max(0, d.onHand) / d.runRate),
        toDaysCoverAfter: roundTo1(Math.max(0, d.onHand + qty) / d.runRate),
      };
    })
    .filter((line) => line.qty > 0);
}

/** How a product's per-destination run rate was derived — always shown, never
 *  presented as if it were measured when it isn't. */
export type RateBasis = "attributed" | "allocated" | "even";

/**
 * Split a product's blended run rate across destinations, in order of evidence:
 *   "attributed" — the branch's own attributed sales in the window.
 *   "allocated"  — no attributed sales anywhere: fall back to each branch's
 *                  share of the stock it holds.
 *   "even"       — neither signal (shop-wide stockout): split evenly.
 */
export function destinationShares(
  destinations: { locationId: string; onHand: number; attributedUnits: number }[]
): { basis: RateBasis; shareByLocation: Map<string, number> } {
  const attributed = destinations.reduce((sum, d) => sum + Math.max(0, d.attributedUnits), 0);
  if (attributed > 0) {
    return {
      basis: "attributed",
      shareByLocation: new Map(
        destinations.map((d) => [d.locationId, Math.max(0, d.attributedUnits) / attributed])
      ),
    };
  }
  const stocked = destinations.reduce((sum, d) => sum + Math.max(0, d.onHand), 0);
  if (stocked > 0) {
    return {
      basis: "allocated",
      shareByLocation: new Map(
        destinations.map((d) => [d.locationId, Math.max(0, d.onHand) / stocked])
      ),
    };
  }
  const even = destinations.length > 0 ? 1 / destinations.length : 0;
  return { basis: "even", shareByLocation: new Map(destinations.map((d) => [d.locationId, even])) };
}

/** Clamp a caller-supplied cover horizon into a plannable range. */
export function clampCoverDays(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_COVER_DAYS;
  return Math.min(MAX_COVER_DAYS, Math.max(MIN_COVER_DAYS, Math.round(value as number)));
}

export function clampWindowDays(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_WINDOW_DAYS;
  return Math.min(MAX_WINDOW_DAYS, Math.max(MIN_WINDOW_DAYS, Math.round(value as number)));
}
