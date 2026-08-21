import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Stating a month's seasonality: the action, its gates, and the words a shop
 * reads.
 *
 * Calendar guessing (holidays, paydays) was in the engine and was removed —
 * backtesting showed it hurt without a full season of history to learn from.
 * This is the other kind: a fact the owner holds that the history cannot show,
 * taken on the same terms as a declared promo.
 *
 * Session + revalidation are stubbed; the database work is real. Skips without
 * a local service connection.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const authState = vi.hoisted(() => ({
  session: null as { user: { id: string; name: string | null; email: string } } | null,
  membership: null as
    | { tenantId: string; displayName: string | null; role: string; permissions: unknown }
    | null,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({
  requireSession: async () => authState.session,
  activeMembership: async () => authState.membership,
}));

import { prismaForTenant, prismaService } from "@wezesha/db";
import {
  clearMonthExpectation,
  declareMonthExpectation,
} from "../app/(shell)/settings/signals/actions";
import { getDeclaredSignals } from "../lib/data/signals";
import { busynessLabel, monthLabel } from "../app/(shell)/settings/signals/month-expectation-card";

const SLUGS = ["month-exp-a", "month-exp-b"];
const MONTH = "2026-12";

describe.skipIf(!runnable)("stating a month's seasonality (local db)", () => {
  let tenantA: string;
  let tenantB: string;

  const actAs = (tenantId: string, role: "OWNER" | "MEMBER" = "OWNER") => {
    authState.session = { user: { id: "month-user", name: "The owner", email: "o@test" } };
    authState.membership = { tenantId, displayName: "The owner", role, permissions: null };
  };

  beforeAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: { in: SLUGS } } });
    const a = await prismaService.tenant.create({ data: { name: "Month A", slug: SLUGS[0]! } });
    const b = await prismaService.tenant.create({ data: { name: "Month B", slug: SLUGS[1]! } });
    tenantA = a.id;
    tenantB = b.id;
  }, 60_000);

  beforeEach(async () => {
    await prismaService.monthlyContext.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
    actAs(tenantA);
  });

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: { in: SLUGS } } });
    await prismaService.$disconnect();
  });

  it("stores what the shop stated", async () => {
    const res = await declareMonthExpectation({ month: MONTH, multiplier: 3, note: "Christmas" });
    expect(res.ok).toBe(true);

    const row = await prismaForTenant(tenantA).monthlyContext.findFirst({ where: { month: MONTH } });
    expect(row?.expectedMultiplier).toBe(3);
    expect(row?.notes).toBe("Christmas");
  });

  it("replaces rather than stacks when a month is restated", async () => {
    await declareMonthExpectation({ month: MONTH, multiplier: 3 });
    await declareMonthExpectation({ month: MONTH, multiplier: 2 });

    const rows = await prismaForTenant(tenantA).monthlyContext.findMany({ where: { month: MONTH } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.expectedMultiplier).toBe(2);
  });

  it("refuses a figure outside what can be sized, rather than clamping it silently", async () => {
    // A shop that typed 40 meant something; storing 4 would be a number nobody
    // chose, sitting in the forecast unnoticed.
    for (const bad of [0, -1, 40, 0.01]) {
      const res = await declareMonthExpectation({ month: MONTH, multiplier: bad });
      expect(res.ok, String(bad)).toBe(false);
    }
    const rows = await prismaForTenant(tenantA).monthlyContext.findMany();
    expect(rows).toHaveLength(0);
  });

  it("refuses a month that is not a month", async () => {
    for (const bad of ["", "2026", "2026-13", "december", "2026-00"]) {
      const res = await declareMonthExpectation({ month: bad, multiplier: 2 });
      expect(res.ok, bad).toBe(false);
    }
  });

  it("is closed to a member", async () => {
    actAs(tenantA, "MEMBER");
    const res = await declareMonthExpectation({ month: MONTH, multiplier: 2 });
    expect(res.ok).toBe(false);
    expect(await prismaService.monthlyContext.count({ where: { tenantId: tenantA } })).toBe(0);
  });

  it("puts a month back to normal without discarding the shop's notes", async () => {
    await declareMonthExpectation({ month: MONTH, multiplier: 3, note: "Christmas trade" });
    const res = await clearMonthExpectation({ month: MONTH });
    expect(res.ok).toBe(true);

    const row = await prismaForTenant(tenantA).monthlyContext.findFirst({ where: { month: MONTH } });
    expect(row?.expectedMultiplier).toBeNull();
    // The note was never the thing being cleared.
    expect(row?.notes).toBe("Christmas trade");
  });

  it("says so when a month is already normal", async () => {
    expect((await clearMonthExpectation({ month: MONTH })).ok).toBe(false);
  });

  it("cannot clear another workspace's month", async () => {
    actAs(tenantB);
    await declareMonthExpectation({ month: MONTH, multiplier: 3 });

    actAs(tenantA);
    expect((await clearMonthExpectation({ month: MONTH })).ok).toBe(false);

    const theirs = await prismaService.monthlyContext.findFirst({ where: { tenantId: tenantB } });
    expect(theirs?.expectedMultiplier).toBe(3);
  });

  it("surfaces only this workspace's months to the screen", async () => {
    actAs(tenantB);
    await declareMonthExpectation({ month: MONTH, multiplier: 4 });
    actAs(tenantA);
    await declareMonthExpectation({ month: "2027-01", multiplier: 0.5 });

    const data = await getDeclaredSignals(tenantA);
    expect(data.months).toEqual([{ month: "2027-01", multiplier: 0.5 }]);
  });

  it("leaves a month noted without a figure out of the forecast's way", async () => {
    await prismaService.monthlyContext.create({
      data: { tenantId: tenantA, month: MONTH, seasonalExpectation: "busy I think" },
    });
    const data = await getDeclaredSignals(tenantA);
    expect(data.months).toHaveLength(0);
  });
});

describe("the words a shop reads", () => {
  it("says how busy in plain terms, never a multiplier", () => {
    expect(busynessLabel(1)).toContain("normal");
    expect(busynessLabel(1.5)).toContain("50% busier");
    expect(busynessLabel(0.5)).toContain("50% quieter");
    expect(busynessLabel(3)).toContain("double");
    for (const m of [0.25, 0.5, 1, 1.5, 2, 4]) {
      expect(busynessLabel(m)).not.toContain("x");
      expect(busynessLabel(m)).not.toContain("multiplier");
    }
  });

  it("names the month rather than printing its key", () => {
    expect(monthLabel("2026-12")).toBe("December 2026");
    expect(monthLabel("2027-01")).toBe("January 2027");
    // A malformed key degrades rather than throwing.
    expect(monthLabel("nonsense")).toBe("nonsense");
  });
});
