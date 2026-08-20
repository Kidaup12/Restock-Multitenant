import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Scoring the forecast on demand.
 *
 * The walk-forward check has only ever run monthly on the worker, so "how
 * accurate is the forecast?" could be answered no more recently than the first
 * of the month, and a shop that had just connected could not answer it at all.
 * Every other figure on that page is same-day.
 *
 * What these hold: the tenant comes from the membership and never from the
 * request, a money-blind member cannot trigger a write, and a shop with too
 * little history gets a sentence rather than a 500 — being unscoreable is not
 * a failure.
 */

const authState: {
  session: { user: { id: string } } | null;
  membership: { tenantId: string; role: string; permissions: unknown } | null;
} = { session: null, membership: null };

const runBacktestMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", () => ({
  getSession: async () => authState.session,
  activeMembership: async () => authState.membership,
}));
vi.mock("@wezesha/forecast-run", () => ({ runBacktest: runBacktestMock }));
vi.mock("@/lib/observability/wrap", () => ({
  withCapture: (handler: unknown) => handler,
}));

import { POST } from "@/app/api/forecast/backtest/route";

const OWNER = { tenantId: "t-1", role: "OWNER", permissions: null };
const MEMBER = { tenantId: "t-1", role: "MEMBER", permissions: null };

const scored = {
  rowsWritten: 8,
  degraded: false,
  methodChanged: false,
  result: {
    byClass: [
      { abcClass: "ALL", method: "run_rate", saidUnits: 948.5, happenedUnits: 1019, sampleSize: 68 },
      { abcClass: "A", method: "run_rate", saidUnits: 568.4, happenedUnits: 605, sampleSize: 32 },
    ],
  },
};

beforeEach(() => {
  authState.session = { user: { id: "u-1" } };
  authState.membership = OWNER;
  runBacktestMock.mockReset();
  runBacktestMock.mockResolvedValue(scored);
});

afterEach(() => vi.clearAllMocks());

describe("POST /api/forecast/backtest", () => {
  it("scores the caller's own workspace", async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    // The tenant is the membership's, never anything a caller could supply.
    expect(runBacktestMock).toHaveBeenCalledWith("t-1");

    const body = await res.json();
    expect(body.rowsWritten).toBe(8);
    // The whole-shop row under the reigning method, which is what the accuracy
    // tab speaks in: units said against units sold, never an error percentage.
    expect(body.scored).toMatchObject({ saidUnits: 948.5, happenedUnits: 1019, sampleSize: 68 });
  });

  it("refuses a caller with no session", async () => {
    authState.session = null;
    const res = await POST();
    expect(res.status).toBe(401);
    expect(runBacktestMock).not.toHaveBeenCalled();
  });

  it("refuses a caller with no workspace", async () => {
    authState.membership = null;
    const res = await POST();
    expect(res.status).toBe(403);
    expect(runBacktestMock).not.toHaveBeenCalled();
  });

  it("refuses a member — it writes a grade row", async () => {
    authState.membership = MEMBER;
    const res = await POST();
    expect(res.status).toBe(403);
    // The gate has to stop the work, not just the response.
    expect(runBacktestMock).not.toHaveBeenCalled();
  });

  it("says a shop cannot be scored yet rather than erroring", async () => {
    // Too little history to produce a single walk-forward cutoff. That is a
    // young shop, not a fault.
    runBacktestMock.mockResolvedValue({
      rowsWritten: 0,
      degraded: false,
      methodChanged: false,
      result: null,
    });
    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rowsWritten).toBe(0);
    expect(body.scored).toBeNull();
  });

  it("passes the degradation flags through", async () => {
    runBacktestMock.mockResolvedValue({ ...scored, degraded: true, methodChanged: true });
    const body = await (await POST()).json();
    expect(body.degraded).toBe(true);
    expect(body.methodChanged).toBe(true);
  });
});
