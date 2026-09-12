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
  /** How long ago, for the header pill: "just now", "4h ago", "3d ago". Decided
   *  here with the rest of the verdict so a screen cannot print an age that
   *  disagrees with the sentence beside it. */
  relative: string;
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

/** Coarse and deliberately so: nobody acts differently on 4h against 5h, and a
 *  minute-accurate reading invites re-reading it.
 *
 *  Past a day it reports the SAME calendar nights the sentence does, rather than
 *  flooring elapsed hours. The two disagree whenever the gap is not a whole
 *  number of days: a run at 19:07 read four calendar days later is 90 elapsed
 *  hours, which floors to three. The banner said "computed 8 Sept — 4 nights
 *  ago" and "(3d ago)" in one sentence, on a live shop. */
function relativeAge(ageMs: number, nights: number): string {
  const minutes = Math.floor(ageMs / (60 * 1000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${nights}d ago`;
}

export function planFreshnessLabel(runDate: Date | string, now: number = Date.now()): PlanFreshness {
  const day = new Date(runDate).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const nights = nightsAgo(runDate, now);
  const relative = relativeAge(planAgeMs(runDate, now), nights);
  if (!isPlanStale(runDate, now)) {
    return { tone: "neutral", text: `Plan computed ${day}`, short: `run ${day}`, relative };
  }
  // A gap over the 36h threshold can still be one calendar night — a run at
  // 01:00 read at 14:00 the next day is 37 hours and one night.
  const nightWord = nights === 1 ? "night" : "nights";
  return {
    tone: "warning",
    text: `This plan was computed ${day} — ${nights} ${nightWord} ago. The overnight run has not finished since, so these numbers are behind your stock.`,
    short: `${nights} ${nightWord} out of date`,
    relative,
  };
}
