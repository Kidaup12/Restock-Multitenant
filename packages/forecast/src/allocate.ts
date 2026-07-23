/**
 * Pure budget allocator for the restock planner's buy list.
 *
 * Contract: `scored` is already sorted by priority (score desc) and already
 * filtered to a positive cost — zero-cost / missing-cost products are excluded
 * upstream so they can never be packed "for free".
 *
 * Greedy fill: by default criticals are always taken (overflow surfaced by the
 * caller); the rest fill the remaining budget in order. With no budget, take
 * everything.
 *
 * `strict` mode: never exceed the budget — criticals are NOT force-included;
 * the list is filled purely greedily by score (criticals rank first, so they
 * still win, but a critical that doesn't fit is deferred like anything else).
 * The caller flags any deferred criticals as at-risk.
 */
export type Allocatable = { cost: number; urgency: string };

export type Allocation<T> = { selected: T[]; deferred: T[]; usedKes: number };

export function allocateByBudget<T extends Allocatable>(
  scored: T[],
  budgetKes: number | null,
  strict = false
): Allocation<T> {
  if (budgetKes == null) {
    return {
      selected: [...scored],
      deferred: [],
      usedKes: scored.reduce((s, x) => s + x.cost, 0),
    };
  }

  const selected: T[] = [];
  const deferred: T[] = [];
  let usedKes = 0;

  if (strict) {
    // Hard cap: fill greedily by score, defer anything that won't fit — including
    // criticals. Total never exceeds the budget.
    for (const s of scored) {
      if (usedKes + s.cost <= budgetKes) {
        selected.push(s);
        usedKes += s.cost;
      } else {
        deferred.push(s);
      }
    }
    return { selected, deferred, usedKes };
  }

  // Pass 1: criticals are non-negotiable — always included (may overflow).
  for (const s of scored) {
    if (s.urgency === "critical") {
      selected.push(s);
      usedKes += s.cost;
    }
  }
  // Pass 2: fill the remaining budget greedily by score.
  for (const s of scored) {
    if (s.urgency === "critical") continue;
    if (usedKes + s.cost <= budgetKes) {
      selected.push(s);
      usedKes += s.cost;
    } else {
      deferred.push(s);
    }
  }

  return { selected, deferred, usedKes };
}
