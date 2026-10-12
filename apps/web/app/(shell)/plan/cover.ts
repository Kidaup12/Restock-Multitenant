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
/** The narrowest a typed horizon may go — a step button can't reach below
 *  COVER_MIN, but someone typing a number is answering a different question
 *  ("one day of cover") and nothing stops that being a real, if unusual, plan. */
export const MIN_TYPED_COVER_DAYS = 1;

/** Hold a stepped horizon inside the range the +/- buttons can offer. */
export function clampCoverDays(days: number) {
  return Math.max(COVER_MIN, Math.min(COVER_MAX, Math.round(days)));
}

/**
 * Hold a TYPED horizon inside the server's own ceiling, not the stepper's.
 *
 * The +/- buttons can only ever reach 7–120 (clampCoverDays), but typing was
 * routed through that same clamp, so a shop that typed 200 silently got 120
 * back with no explanation. A typed figure answers to the server's actual
 * limit (MAX_COVER_DAYS) instead — the one thing it still can't be is a
 * horizon the engine would reject outright.
 */
export function clampTypedCoverDays(days: number) {
  return Math.max(MIN_TYPED_COVER_DAYS, Math.min(MAX_COVER_DAYS, Math.round(days)));
}
