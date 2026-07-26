import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { seedDev, type SeedResult } from "../../../packages/db/scripts/seed-dev";
import { runForecast } from "../lib/forecast-run/run";
import { getBuyList } from "../lib/data/plan";
import { getSupplyCalendar } from "../lib/data/plan-calendar";

/**
 * Supply calendar against the seeded local database: seed -> forecast ->
 * calendar. The forward buckets and per-supplier cash are recomputed
 * independently from the buy list, so a wrong grouping shows up as a mismatch,
 * and the money-blind redaction is checked owner-vs-member. Skips when no local
 * database is configured.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const HORIZON = 3;

const monthStartOf = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), 1);
const addMonths = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth() + n, 1);
const supplierKey = (name: string | null): string => name ?? " unassigned";

let seeded: SeedResult;

describe.skipIf(!runnable)("supply calendar (seeded local db)", () => {
  beforeAll(async () => {
    // Publish must degrade to a no-op without a broker configured.
    delete process.env.REDIS_URL;
    seeded = await seedDev();
    await runForecast(seeded.tenantId);
  }, 120_000);

  afterAll(async () => {
    await prismaService.$disconnect();
  });

  it("buckets order-by dates forward and groups them by supplier", async () => {
    const now = new Date();
    const [calendar, buyList] = await Promise.all([
      getSupplyCalendar(seeded.tenantId, { canViewCosts: true, now, horizonMonths: HORIZON }),
      getBuyList(seeded.tenantId, { canViewCosts: true }),
    ]);
    expect(buyList).not.toBeNull();
    expect(calendar.runDate?.getTime()).toBe(buyList!.runDate.getTime());

    // The buckets are the current month plus the next two, in order.
    const firstMonth = monthStartOf(now);
    expect(calendar.buckets).toHaveLength(HORIZON);
    calendar.buckets.forEach((bucket, i) => {
      expect(bucket.monthStart.getTime()).toBe(addMonths(firstMonth, i).getTime());
      // Grouping by supplier: each supplier appears at most once in a bucket.
      const names = bucket.suppliers.map((s) => supplierKey(s.supplierName));
      expect(new Set(names).size).toBe(names.length);
      // A bucket's totals reconcile with its own supplier groups.
      expect(bucket.itemCount).toBe(bucket.suppliers.reduce((n, s) => n + s.itemCount, 0));
      expect(bucket.cashKes).toBeCloseTo(
        bucket.suppliers.reduce((n, s) => n + (s.cashKes ?? 0), 0),
        5
      );
    });

    // Independent recompute: fold every buy-list row into its month + supplier.
    const horizonEnd = addMonths(firstMonth, HORIZON);
    type Cell = { count: number; cash: number };
    const expected: Map<string, Cell>[] = Array.from({ length: HORIZON }, () => new Map());
    let expectedBeyond = 0;
    for (const row of buyList!.rows) {
      const orderBy = new Date(row.orderByDate);
      let idx: number | null;
      if (orderBy < firstMonth) idx = 0; // overdue folds into the current month
      else if (orderBy >= horizonEnd) idx = null; // past the horizon
      else idx = (orderBy.getFullYear() - firstMonth.getFullYear()) * 12 + (orderBy.getMonth() - firstMonth.getMonth());
      if (idx === null) {
        expectedBeyond += 1;
        continue;
      }
      const key = supplierKey(row.supplierName);
      const cell = expected[idx]!.get(key) ?? { count: 0, cash: 0 };
      cell.count += 1;
      cell.cash += row.lineTotalKes ?? 0;
      expected[idx]!.set(key, cell);
    }

    expect(calendar.beyondHorizonItems).toBe(expectedBeyond);
    calendar.buckets.forEach((bucket, i) => {
      const exp = expected[i]!;
      expect(bucket.suppliers).toHaveLength(exp.size);
      for (const group of bucket.suppliers) {
        const cell = exp.get(supplierKey(group.supplierName));
        expect(cell, `${bucket.key} / ${group.supplierName}`).toBeDefined();
        expect(group.itemCount).toBe(cell!.count);
        expect(group.cashKes).toBeCloseTo(cell!.cash, 5);
      }
    });

    // Nothing is dropped or double-counted across the buckets.
    const bucketed = calendar.buckets.reduce((n, b) => n + b.itemCount, 0);
    expect(bucketed + calendar.beyondHorizonItems).toBe(buyList!.rows.length);
    expect(calendar.totalItemCount).toBe(bucketed);
    expect(calendar.totalCashKes).toBeCloseTo(
      buyList!.rows.reduce((n, r) => n + (r.lineTotalKes ?? 0), 0) -
        // rows beyond the horizon aren't in the total
        calendarBeyondCash(buyList!.rows, firstMonth, horizonEnd),
      5
    );
    if (calendar.totalItemCount > 0) expect(calendar.totalCashKes!).toBeGreaterThan(0);
  });

  it("redacts every cash figure for a money-blind member, keeps counts and dates", async () => {
    const now = new Date();
    const [owner, member] = await Promise.all([
      getSupplyCalendar(seeded.tenantId, { canViewCosts: true, now, horizonMonths: HORIZON }),
      getSupplyCalendar(seeded.tenantId, { canViewCosts: false, now, horizonMonths: HORIZON }),
    ]);

    // Owner sees money.
    expect(typeof owner.totalCashKes).toBe("number");
    expect(owner.openCommittedKes).not.toBeNull();

    // Member: every KES aggregate is null, top to bottom.
    expect(member.totalCashKes).toBeNull();
    expect(member.openCommittedKes).toBeNull();
    for (const bucket of member.buckets) {
      expect(bucket.cashKes).toBeNull();
      for (const s of bucket.suppliers) expect(s.cashKes).toBeNull();
    }
    for (const c of member.openCommitments) expect(c.committedKes).toBeNull();

    // Non-money structure is identical: counts, dates, supplier names survive.
    expect(member.totalItemCount).toBe(owner.totalItemCount);
    expect(member.beyondHorizonItems).toBe(owner.beyondHorizonItems);
    expect(member.openOrderLines).toBe(owner.openOrderLines);
    expect(member.buckets.map((b) => b.key)).toEqual(owner.buckets.map((b) => b.key));
    owner.buckets.forEach((ob, i) => {
      const mb = member.buckets[i]!;
      expect(mb.itemCount).toBe(ob.itemCount);
      expect(mb.monthStart.getTime()).toBe(ob.monthStart.getTime());
      expect(mb.suppliers.map((s) => [s.supplierName, s.itemCount])).toEqual(
        ob.suppliers.map((s) => [s.supplierName, s.itemCount])
      );
    });
  });

  it("orders suppliers by cash for both roles, not just the one that can see it", async () => {
    // Regression: the calendar used to build on a redacted buy list, so every
    // group summed to zero cash for a member and the sort fell through to
    // count-then-name. Both roles must walk the suppliers in the same order,
    // and that order must be the cash ranking — otherwise staff and owner work
    // a restock list with different priorities.
    const now = new Date();
    const [owner, member] = await Promise.all([
      getSupplyCalendar(seeded.tenantId, { canViewCosts: true, now, horizonMonths: HORIZON }),
      getSupplyCalendar(seeded.tenantId, { canViewCosts: false, now, horizonMonths: HORIZON }),
    ]);

    for (const [i, ob] of owner.buckets.entries()) {
      const cash = ob.suppliers.map((s) => s.cashKes ?? 0);
      expect(cash).toEqual([...cash].sort((a, b) => b - a));
      expect(member.buckets[i]!.suppliers.map((s) => s.supplierName)).toEqual(
        ob.suppliers.map((s) => s.supplierName)
      );
    }
  });

  it("scopes to the tenant: another tenant's calendar is empty", async () => {
    const probe = await prismaService.tenant.create({
      data: { name: "Calendar Probe", slug: "plan-calendar-probe" },
    });
    try {
      const calendar = await getSupplyCalendar(probe.id, { canViewCosts: true });
      expect(calendar.runDate).toBeNull();
      expect(calendar.totalItemCount).toBe(0);
      expect(calendar.openOrderLines).toBe(0);
      expect(calendar.openCommitments).toHaveLength(0);
      for (const bucket of calendar.buckets) expect(bucket.itemCount).toBe(0);
    } finally {
      await prismaService.tenant.delete({ where: { id: probe.id } });
    }
  });
});

/** Cash carried by buy-list rows whose order-by date is past the horizon. */
function calendarBeyondCash(
  rows: { orderByDate: Date; lineTotalKes: number | null }[],
  firstMonth: Date,
  horizonEnd: Date
): number {
  return rows.reduce((sum, r) => {
    const d = new Date(r.orderByDate);
    return d >= horizonEnd && d >= firstMonth ? sum + (r.lineTotalKes ?? 0) : sum;
  }, 0);
}
