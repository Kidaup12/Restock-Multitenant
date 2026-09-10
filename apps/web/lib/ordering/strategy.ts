import { METHOD_DEFAULTS, ORDER_METHODS, type OrderMethod } from "@wezesha/forecast";

/**
 * How the three buying styles are described to a shop owner.
 *
 * One definition, used by the strategy page and the summary card in Settings.
 * They were about to be written twice, and a summary that drifts from the thing
 * it summarises is worse than no summary: it tells someone their slow movers
 * are set to free up cash while the page says otherwise.
 *
 * Deliberately NO z-values or service-level maths here. The engine's own note
 * (packages/forecast/src/config.ts) is that raw statistics are the engine's, not
 * a shop owner's — the CHOICE belongs to the owner, the arithmetic does not. So
 * each option is described by what it does to the shop: how often you are in
 * stock, what it does to cash, and what it risks.
 */

export type StrategyClass = "A" | "B" | "C";

export type StrategyOption = {
  method: OrderMethod;
  label: string;
  /** One line under the label. */
  summary: string;
  /** The three trade-off chips, in a fixed order: service, cash, risk. */
  inStock: string;
  cash: string;
  risk: string;
  /** When this is the right answer — the sentence that actually decides it. */
  bestFor: string;
};

export const STRATEGY_OPTIONS: readonly StrategyOption[] = [
  {
    method: "stay_in_stock",
    label: "Never run out",
    summary: "Rarely run out — hold a little more",
    inStock: "95% in stock",
    cash: "Ties up more cash",
    risk: "Lowest stockout risk",
    bestFor:
      "Fast, erratic best-sellers where a stockout is a lost sale you can't get back.",
  },
  {
    method: "balanced",
    label: "Balanced",
    summary: "A sensible middle — good cover, lean cash",
    inStock: "90% in stock",
    cash: "Moderate cash",
    risk: "Low stockout risk",
    bestFor: "Mid-tier products that matter but aren't your headline sellers.",
  },
  {
    method: "lean_cash",
    label: "Free up cash",
    summary: "Don't over-buy slow movers",
    inStock: "~2 weeks cover",
    cash: "Frees the most cash",
    risk: "Accepts some stockouts",
    bestFor:
      "The slow, lumpy long tail where a stockout costs little and chasing 95% just freezes money.",
  },
] as const;

export type StrategyGroup = {
  key: StrategyClass;
  label: string;
  /** What lands in this group, in the shop's terms rather than "Class A". */
  scope: string;
  hint: string;
};

/**
 * The three groups.
 *
 * Named for what they ARE rather than A/B/C. The reference labels them by
 * class and puts the revenue share beside it; the share is the useful half —
 * "Class A" tells an owner nothing, "roughly 70% of your revenue" tells them
 * why it deserves the careful setting.
 */
export const STRATEGY_GROUPS: readonly StrategyGroup[] = [
  {
    key: "A",
    label: "Best sellers",
    scope: "Roughly 70% of your revenue",
    hint: "The lines that bring in most of your money.",
  },
  {
    key: "B",
    label: "Steady sellers",
    scope: "The next 20%",
    hint: "Reliable middle of the catalogue.",
  },
  {
    key: "C",
    label: "Slow movers",
    scope: "The last 10% — most of your SKUs, least of your sales",
    hint: "The long tail.",
  },
] as const;

/** The engine's own default for a group — shown as "Recommended" so an owner
 *  can tell a deliberate choice from one nobody has revisited. */
export function recommendedFor(group: StrategyClass): OrderMethod {
  return METHOD_DEFAULTS[group];
}

export function optionFor(method: OrderMethod): StrategyOption {
  return STRATEGY_OPTIONS.find((o) => o.method === method) ?? STRATEGY_OPTIONS[1]!;
}

/** Guards the vocabulary against the engine growing a method nobody described.
 *  An undescribed option would render as a blank card. */
export function everyMethodDescribed(): boolean {
  return ORDER_METHODS.every((m) => STRATEGY_OPTIONS.some((o) => o.method === m));
}
