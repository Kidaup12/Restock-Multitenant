import Link from "next/link";
import type { BuyListRow } from "@/lib/data/plan";

/**
 * The checks worth making before any of this list turns into a purchase order.
 *
 * Each one is a reason a quantity or a date on the list can't be trusted yet,
 * and each names the screen that fixes it — a warning nobody can act on is just
 * a worry. When they all pass it says so in one line, because "nothing is wrong"
 * is the answer the owner is actually looking for before they spend.
 *
 * Everything here is read off the rows already on screen: no extra fetch, and
 * nothing a money-blind member can't see (counts, suppliers and dates, never a
 * cost).
 */

export type PreflightCheck = {
  /** What's wrong, in one sentence, with the count that makes it concrete. */
  text: string;
  /** Where to go and fix it. */
  href: string;
  action: string;
};

export type Preflight = {
  checks: PreflightCheck[];
  /** Rows with stock already on its way — context for the clear line, not a warning. */
  onTheWay: number;
};

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** Pure: the whole strip's content from the plan's rows. */
export function preflight(rows: BuyListRow[]): Preflight {
  const negative = rows.filter((r) => r.onHandUnits < 0);
  const noSupplier = rows.filter((r) => r.supplierName == null);
  const onDraftPo = rows.filter((r) => r.doubleOrderWarn);

  const checks: PreflightCheck[] = [];

  if (negative.length > 0) {
    checks.push({
      text: `${negative.length} ${plural(negative.length, "product has", "products have")} a negative stock count, so ${plural(negative.length, "its", "their")} order quantity can't be trusted until the count is fixed.`,
      href: "/stock",
      action: "Fix counts",
    });
  }
  if (noSupplier.length > 0) {
    checks.push({
      text: `${negative.length === 0 ? "" : "Another "}${noSupplier.length} ${plural(noSupplier.length, "product has", "products have")} no supplier, so the order-by ${plural(noSupplier.length, "date is an estimate", "dates are estimates")} rather than a real delivery time.`,
      href: "/suppliers",
      action: "Assign suppliers",
    });
  }
  if (onDraftPo.length > 0) {
    checks.push({
      text: `${onDraftPo.length} ${plural(onDraftPo.length, "product is", "products are")} already on a draft purchase order — ordering ${plural(onDraftPo.length, "it", "them")} again would double up.`,
      href: "/orders",
      action: "Review drafts",
    });
  }

  return { checks, onTheWay: rows.filter((r) => r.onOrderUnits > 0).length };
}

export function PreflightStrip({ rows }: { rows: BuyListRow[] }) {
  const { checks, onTheWay } = preflight(rows);

  if (checks.length === 0) {
    return (
      <p className="text-sm text-positive">
        Clear to order — counts look clean, every line has a supplier, nothing is
        already on a draft order.
        {onTheWay > 0 && (
          <span className="text-ink-muted">
            {" "}
            · {onTheWay} {plural(onTheWay, "product has", "products have")} stock already on the way
          </span>
        )}
      </p>
    );
  }

  return (
    <div className="rounded-lg border border-warning bg-warning-soft p-3">
      <p className="text-sm font-medium text-warning">Check before ordering</p>
      <ul className="mt-1.5 space-y-1">
        {checks.map((check) => (
          <li key={check.href} className="flex flex-wrap items-baseline gap-x-2 text-sm text-warning">
            <span>{check.text}</span>
            <Link href={check.href} className="font-medium underline-offset-2 hover:underline">
              {check.action} →
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
