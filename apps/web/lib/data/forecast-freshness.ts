/**
 * How old the plan on screen is, and whether that is worth saying.
 *
 * The run date was already carried and already printed — as neutral grey text on
 * one screen of one mode. So when the nightly run died for two nights in August,
 * the buy list said "run 3 Aug" and otherwise looked exactly like a fresh one.
 * Reading a date is not the same as noticing it is wrong, which is what this
 * turns into a sentence.
 */

const HOUR_MS = 60 * 60 * 1000;

/** A plan computed at 02:00 yesterday is ~30h old by opening time today and is
 *  perfectly healthy — the run is nightly, not continuous. 36h is the first
 *  threshold only reachable by MISSING a night. A 24h rule would cry stale every
 *  afternoon and teach the owner to ignore the banner, which is worse than
 *  saying nothing. */
export const PLAN_STALE_AFTER_MS = 36 * HOUR_MS;

export type PlanFreshness = {
  tone: "neutral" | "warning";
  /** One sentence for the owner. Never a bare date. */
  text: string;
  /** The same fact where only a few words fit — a card subtitle, a header. */
  short: string;
};

/** Clock passed in, not read during render — react-hooks/purity bans Date.now()
 *  there, and the tests need to sit either side of the threshold. */
export function planAgeMs(runDate: Date | string, now: number = Date.now()): number {
  return now - new Date(runDate).getTime();
}

export function isPlanStale(runDate: Date | string, now: number = Date.now()): boolean {
  return planAgeMs(runDate, now) > PLAN_STALE_AFTER_MS;
}

/** Nights between the run and now, counted in calendar days rather than elapsed
 *  hours — the sentence prints the run's date right beside the count, and the two
 *  have to agree with what the owner sees on a calendar. Elapsed-hours arithmetic
 *  does not: a run at 02:00 and a reading at 08:00 three days later is 72h, which
 *  rounds to a different number of "nights" depending on the hour of day. */
function nightsAgo(runDate: Date | string, now: number): number {
  const midnight = (d: Date): number =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(new Date(now)) - midnight(new Date(runDate))) / (24 * HOUR_MS));
  return Math.max(1, days);
}

export function planFreshnessLabel(runDate: Date | string, now: number = Date.now()): PlanFreshness {
  const day = new Date(runDate).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  if (!isPlanStale(runDate, now)) {
    return { tone: "neutral", text: `Plan computed ${day}`, short: `run ${day}` };
  }
  const nights = nightsAgo(runDate, now);
  return {
    tone: "warning",
    text: `This plan was computed ${day} — ${nights} nights ago. The overnight run has not finished since, so these numbers are behind your stock.`,
    short: `${nights} nights out of date`,
  };
}
