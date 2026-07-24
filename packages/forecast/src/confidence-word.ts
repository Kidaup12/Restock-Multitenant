/**
 * Confidence vocabulary — the honesty word that rides on every forecast number.
 *
 * A guess must never wear the same font of certainty as a sure number (spec §6).
 * This maps the raw signal quality of one product's forecast to one of three
 * plain words the whole UI speaks: sure / fairly sure / guessing. It is a pure
 * function of the signals; the caller (the engine) supplies them.
 *
 * The word is deliberately conservative: any single serious quality problem
 * (almost no history, wild variance, shelves empty half the window, a cold
 * start) pulls the whole number down to "guessing". "Sure" is only earned by a
 * full season of steady, in-stock, promo-free demand.
 */

export type ConfidenceWord = "sure" | "fairly_sure" | "guessing";

export type ConfidenceSignals = {
  /** Days of sales history behind the number (0 = brand new). */
  historyDays: number;
  /** Coefficient of variation of recent daily demand (std / mean). Higher = more erratic. */
  cv: number;
  /** Share of the rate window lost to stockouts, 0..1 (proven or inferred). */
  stockoutGapShare: number;
  /** An active promo is inflating the number right now — not a clean baseline. */
  promoContaminated: boolean;
  /** Cold start: too new to forecast from its own sales, or borrowing another
   *  product's shape. Either way there is no real history to be sure about. */
  coldStart: boolean;
};

/** A full season of history before a number can read as "sure". */
export const SURE_MIN_HISTORY_DAYS = 90;
/** Steady demand: variation under half the mean. */
export const SURE_MAX_CV = 0.5;
/** Clean shelves: under a tenth of the window censored. */
export const SURE_MAX_STOCKOUT_SHARE = 0.1;

/** Under three weeks of history there is nothing to be more than a guess about. */
export const GUESS_MAX_HISTORY_DAYS = 21;
/** Variation at or above the mean is noise, not signal. */
export const GUESS_MIN_CV = 1.0;
/** Shelves empty 40%+ of the window: the rate is a guess, however corrected. */
export const GUESS_MIN_STOCKOUT_SHARE = 0.4;

const RANK: Record<ConfidenceWord, number> = { guessing: 0, fairly_sure: 1, sure: 2 };

/** The lower (less certain) of two words — used to cap a number's confidence. */
export function leastConfident(a: ConfidenceWord, b: ConfidenceWord): ConfidenceWord {
  return RANK[a] <= RANK[b] ? a : b;
}

export function confidenceWord(s: ConfidenceSignals): ConfidenceWord {
  // A cold start or near-empty history has no basis for certainty, full stop.
  if (s.coldStart || s.historyDays < GUESS_MAX_HISTORY_DAYS) return "guessing";

  // Any single severe quality problem drops the number to a guess.
  if (s.cv >= GUESS_MIN_CV || s.stockoutGapShare >= GUESS_MIN_STOCKOUT_SHARE) return "guessing";

  // "Sure" is earned, not defaulted: a full season, steady, in stock, no promo skew.
  if (
    s.historyDays >= SURE_MIN_HISTORY_DAYS &&
    s.cv <= SURE_MAX_CV &&
    s.stockoutGapShare <= SURE_MAX_STOCKOUT_SHARE &&
    !s.promoContaminated
  ) {
    return "sure";
  }

  // Real history, but with a caveat (short-ish, some variance, a promo running,
  // a little stockout noise): honest middle ground.
  return "fairly_sure";
}
