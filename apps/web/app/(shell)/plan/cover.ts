/**
 * The days-of-cover horizon, shared by both planner modes.
 *
 * The checklist steps it as a what-if lens; the budget allocator takes it as an
 * optional target alongside the cash cap. One definition, because two would
 * drift — a horizon that means 30 days on one screen and 28 on the other is a
 * number the shop stops trusting.
 *
 * The stepper range and the server ceiling are deliberately different. The
 * stepper offers the window a shop actually buys to; the ceiling only has to
 * refuse nonsense from a hand-made call, so it sits far wider than any button
 * can reach.
 */

export const COVER_MIN = 7;
export const COVER_MAX = 120;
export const COVER_STEP = 7;

/** Where the checklist's what-if lens starts when a reader first engages it. */
export const DEFAULT_COVER_DAYS = 30;

/**
 * Where the budget allocator's cover target starts, and it starts switched ON —
 * spending a budget without saying how long it should last leaves the horizon
 * implicit. Three weeks is the window a shop reorders on, and it matches the
 * figure the client saw demonstrated. Deliberately not the same as the
 * checklist's lens: that one is an exploration a reader opts into, this one is
 * part of the question budget mode asks.
 */
export const DEFAULT_BUDGET_COVER_DAYS = 21;

/** The widest horizon the server will accept from any caller. */
export const MAX_COVER_DAYS = 365;

/** Hold a stepped horizon inside the range the buttons can offer. */
export function clampCoverDays(days: number) {
  return Math.max(COVER_MIN, Math.min(COVER_MAX, Math.round(days)));
}
