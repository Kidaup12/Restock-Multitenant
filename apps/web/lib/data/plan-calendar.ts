import { prismaForTenant } from "@wezesha/db";
import { getBuyList } from "./plan";

/**
 * Forward supply calendar for the Plan screen: the buy list's order-by dates
 * bucketed into the next few monthly windows and grouped by supplier, so the
 * shop sees its upcoming ordering commitments — when to order from whom, and
 * how much cash it takes — at a glance. Open purchase orders are folded in as
 * an "already on order" summary so recommended orders read against what is
 * already in flight.
 *
 * Server-only: takes an explicit tenantId and runs on the RLS-enforced tenant
 * client. Read-only — no writes.
 *
 * Money-blind, redacted here rather than at render (mirrors plan.ts): the cash
 * figures are cost-derived, so `getSupplyCalendar` takes an explicit
 * `canViewCosts` and nulls every KES aggregate when it is false — a money-blind
 * member's payload carries item counts, supplier names, and dates, never the
 * money.
 */

/** Number of forward monthly windows the calendar spans by default. */
const DEFAULT_HORIZON_MONTHS = 3;

/** Open PO statuses = placed but not yet received or withdrawn. */
const OPEN_PO_STATUSES = ["draft", "sent", "partially_received"];

/** Open Order statuses = queued to buy or on a live PO, not received/cancelled. */
const OPEN_ORDER_STATUSES = ["pending", "ordered"];

export type CalendarSupplierGroup = {
  /** Null when the row's product has no supplier on file. */
  supplierName: string | null;
  /** Buy-list lines from this supplier whose order-by date lands in the bucket. */
  itemCount: number;
  /** Sum of the lines' cost to order (lineTotalKes). Null when the caller can't view costs. */
  cashKes: number | null;
};

export type CalendarBucket = {
  /** Stable key, e.g. "2026-08". */
  key: string;
  /** Display label, e.g. "Aug 2026". */
  label: string;
  /** First day of the month this bucket covers (inclusive). */
  monthStart: Date;
  /** Suppliers with something to order this month, most cash (or items) first. */
  suppliers: CalendarSupplierGroup[];
  /** Total lines to order this month across suppliers. */
  itemCount: number;
  /** Total cash to order this month. Null when the caller can't view costs. */
  cashKes: number | null;
};

/** A supplier the shop already has cash committed to on open purchase orders. */
export type SupplierCommitment = {
  supplierName: string | null;
  /** Open (draft/sent/partially received) POs with this supplier. */
  poCount: number;
  /** Sum of those POs' subtotals. Null when the caller can't view costs. */
  committedKes: number | null;
};

export type SupplyCalendar = {
  /** The forecast run the buy list came from, or null when none has run yet. */
  runDate: Date | null;
  /** The day the calendar was anchored on — the first bucket is its month. */
  now: Date;
  horizonMonths: number;
  buckets: CalendarBucket[];
  /** Lines to order across the whole horizon. */
  totalItemCount: number;
  /** Cash to order across the whole horizon. Null when the caller can't view costs. */
  totalCashKes: number | null;
  /** Buy-list lines whose order-by date is beyond the horizon (context, not bucketed). */
  beyondHorizonItems: number;
  /** Order lines already queued or on a live PO (pending/ordered). */
  openOrderLines: number;
  /** Cash already committed on open POs, by supplier — "already on order". */
  openCommitments: SupplierCommitment[];
  /** Sum of open-PO subtotals. Null when the caller can't view costs. */
  openCommittedKes: number | null;
};

const monthStartOf = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), 1);
const addMonths = (d: Date, n: number): Date =>
  new Date(d.getFullYear(), d.getMonth() + n, 1);

const monthKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const monthLabel = (d: Date): string =>
  d.toLocaleDateString("en-GB", { month: "short", year: "numeric" });

/** Group key for a supplier, folding the "no supplier" case to one bucket. */
const supplierKey = (name: string | null): string => name ?? " unassigned";

/**
 * Build the forward calendar. `now` and `horizonMonths` are injectable so tests
 * can drive deterministic buckets; both default to the live values.
 */
export async function getSupplyCalendar(
  tenantId: string,
  {
    canViewCosts,
    now = new Date(),
    horizonMonths = DEFAULT_HORIZON_MONTHS,
  }: { canViewCosts: boolean; now?: Date; horizonMonths?: number }
): Promise<SupplyCalendar> {
  const db = prismaForTenant(tenantId);

  // Build on real costs whatever the caller can see: supplier groups are ordered
  // by cash, so a redacted buy list would sort every group at zero and hand a
  // money-blind member a different running order. redactCalendar nulls the money
  // on the way out instead.
  const [buyList, openPos, openOrderLines] = await Promise.all([
    getBuyList(tenantId, { canViewCosts: true }),
    db.purchaseOrder.findMany({
      where: { status: { in: OPEN_PO_STATUSES }, deletedAt: null },
      select: { subtotalKes: true, vendor: true, supplier: { select: { name: true } } },
    }),
    db.order.count({ where: { status: { in: OPEN_ORDER_STATUSES } } }),
  ]);

  // The month windows: the current month plus the following (horizon - 1).
  const firstMonth = monthStartOf(now);
  const horizonEnd = addMonths(firstMonth, horizonMonths);
  const buckets: CalendarBucket[] = Array.from({ length: horizonMonths }, (_, i) => {
    const monthStart = addMonths(firstMonth, i);
    return {
      key: monthKey(monthStart),
      label: monthLabel(monthStart),
      monthStart,
      suppliers: [] as CalendarSupplierGroup[],
      itemCount: 0,
      cashKes: 0,
    };
  });

  // Which bucket an order-by date falls in: overdue (before this month) folds
  // into the first bucket — it needs ordering now — and anything past the
  // horizon is counted separately, never bucketed.
  const bucketIndexFor = (orderByDate: Date): number | null => {
    if (orderByDate < firstMonth) return 0;
    if (orderByDate >= horizonEnd) return null;
    const idx =
      (orderByDate.getFullYear() - firstMonth.getFullYear()) * 12 +
      (orderByDate.getMonth() - firstMonth.getMonth());
    return idx >= 0 && idx < horizonMonths ? idx : null;
  };

  // Accumulate per-bucket, per-supplier item counts and cash.
  const groupsByBucket = buckets.map(
    () => new Map<string, { name: string | null; count: number; cash: number }>()
  );
  let beyondHorizonItems = 0;

  for (const row of buyList?.rows ?? []) {
    const idx = bucketIndexFor(new Date(row.orderByDate));
    if (idx === null) {
      beyondHorizonItems += 1;
      continue;
    }
    const groups = groupsByBucket[idx]!;
    const key = supplierKey(row.supplierName);
    const group = groups.get(key) ?? { name: row.supplierName, count: 0, cash: 0 };
    group.count += 1;
    group.cash += row.lineTotalKes ?? 0;
    groups.set(key, group);
  }

  let totalItemCount = 0;
  buckets.forEach((bucket, i) => {
    const groups = [...groupsByBucket[i]!.values()].sort(
      (a, b) => b.cash - a.cash || b.count - a.count || (a.name ?? "").localeCompare(b.name ?? "")
    );
    bucket.suppliers = groups.map((g) => ({
      supplierName: g.name,
      itemCount: g.count,
      cashKes: g.cash,
    }));
    bucket.itemCount = groups.reduce((sum, g) => sum + g.count, 0);
    bucket.cashKes = groups.reduce((sum, g) => sum + g.cash, 0);
    totalItemCount += bucket.itemCount;
  });

  // "Already on order": open POs grouped by supplier (or brand label / unnamed).
  const commitMap = new Map<string, { name: string | null; poCount: number; committed: number }>();
  for (const po of openPos) {
    const name = po.supplier?.name ?? po.vendor ?? null;
    const key = supplierKey(name);
    const c = commitMap.get(key) ?? { name, poCount: 0, committed: 0 };
    c.poCount += 1;
    c.committed += po.subtotalKes;
    commitMap.set(key, c);
  }
  const openCommitments = [...commitMap.values()]
    .sort((a, b) => b.committed - a.committed || b.poCount - a.poCount)
    .map((c) => ({ supplierName: c.name, poCount: c.poCount, committedKes: c.committed }));
  const openCommittedKes = openPos.reduce((sum, po) => sum + po.subtotalKes, 0);

  const calendar: SupplyCalendar = {
    runDate: buyList?.runDate ?? null,
    now,
    horizonMonths,
    buckets,
    totalItemCount,
    totalCashKes: buckets.reduce((sum, b) => sum + (b.cashKes ?? 0), 0),
    beyondHorizonItems,
    openOrderLines,
    openCommitments,
    openCommittedKes,
  };

  return canViewCosts ? calendar : redactCalendar(calendar);
}

/** Null out every KES figure for a money-blind caller — dates, supplier names,
 *  and item/PO counts survive, the money does not. */
function redactCalendar(calendar: SupplyCalendar): SupplyCalendar {
  return {
    ...calendar,
    buckets: calendar.buckets.map((b) => ({
      ...b,
      cashKes: null,
      suppliers: b.suppliers.map((s) => ({ ...s, cashKes: null })),
    })),
    totalCashKes: null,
    openCommitments: calendar.openCommitments.map((c) => ({ ...c, committedKes: null })),
    openCommittedKes: null,
  };
}
