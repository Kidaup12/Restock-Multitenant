/**
 * Plain-English hover explainers for the terms a shop owner has to guess at.
 *
 * One shared glossary so a term reads the same wherever it appears. This is the
 * repo's own take on the reference app's `term.tsx`: the copy is ours, the
 * mechanism is a native `title` tooltip plus a small "i" affordance so a reader
 * can SEE there is help rather than discovering the tooltip by accident.
 *
 * Import `GLOSSARY[k].hint` to drop the sentence onto an element's `title`, or
 * render `<Term k="runRate" />` for the label with its dotted underline and info
 * dot. `<InfoDot hint="…" />` adds the affordance to any header of your own.
 */

export const GLOSSARY = {
  // NOT the catalogue's rate name — see tests/one-name-per-rate.test.ts. This is
  // the rate the order was SIZED from (forecast / 30, ABC-floored), distinct from
  // the catalogue's measured "Sells/day".
  runRate: {
    label: "Buying at/day",
    hint: "The daily selling rate the order was sized from — the forecast divided by thirty, floored to the item's ABC class. Distinct from the catalogue's measured Sells/day.",
  },
  daysLeft: {
    label: "Days left",
    hint: "How many days until this runs out at the current selling speed. An empty shelf reads 0d.",
  },
  enRoute: {
    label: "En route",
    hint: "Stock already on its way in — ordered or in transit, not yet on the shelf. Subtracted from the order quantity.",
  },
  abc: {
    label: "ABC class",
    hint: "Ranked by sales value (recent pace × price). A = the top ~70% of sales value, the money-makers to keep in stock; B = the next 20%; C = the slow, low-value tail. Order C sparingly.",
  },
  orderBy: {
    label: "Order by",
    hint: "The last safe day to place the order so stock lands before the shelf runs out — the stockout day minus the supplier's lead time.",
  },
  revenue30: {
    label: "Rev 30d",
    hint: "Actual revenue this product earned over the last 30 days — a sales figure, shown to every role.",
  },
} as const;

export type TermKey = keyof typeof GLOSSARY;

/** Small encircled "i" that signals a hoverable explainer, so a reader can see
 *  there is help instead of stumbling on the tooltip. */
export function InfoDot({ hint, className = "" }: { hint: string; className?: string }) {
  return (
    <span
      title={hint}
      role="img"
      aria-label={`Info: ${hint}`}
      className={`ml-1 inline-flex h-3 w-3 items-center justify-center rounded-full border border-current align-middle text-[8px] leading-none font-semibold cursor-help opacity-55 hover:opacity-90 ${className}`}
    >
      i
    </span>
  );
}

/** The glossary label with a dotted underline and an info dot, so it visibly
 *  reads as "hover me for what this means". Use in table headers and labels. */
export function Term({ k, className = "" }: { k: TermKey; className?: string }) {
  const { label, hint } = GLOSSARY[k];
  return (
    <span className={`inline-flex items-center cursor-help ${className}`} title={hint}>
      <span className="underline decoration-dotted decoration-ink-faint underline-offset-2">
        {label}
      </span>
      <InfoDot hint={hint} />
    </span>
  );
}
