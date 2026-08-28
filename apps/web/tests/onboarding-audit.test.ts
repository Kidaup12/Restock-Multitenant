import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Re-tuning the forecast to a shop on demand.
 *
 * The audit runs a nested backtest and, where the numbers support it, moves the
 * shop onto the routing that fits it best. It can change how the forecast is
 * produced, so it sits behind `manage_settings`.
 *
 * What these hold: the tenant comes from the membership and never from the
 * request, a money-blind member cannot trigger a re-tune, the response carries
 * only shop-facing facts (never a tier or any engine internal), and a shop with
 * too little history gets a neutral reason rather than a 500.
 */

const authState: {
  session: { user: { id: string } } | null;
  membership: { tenantId: string; role: string; permissions: unknown } | null;
} = { session: null, membership: null };

const runOnboardingAuditMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", () => ({
  getSession: async () => authState.session,
  activeMembership: async () => authState.membership,
}));
vi.mock("@wezesha/forecast-run", () => ({ runOnboardingAudit: runOnboardingAuditMock }));
vi.mock("@/lib/observability/wrap", () => ({
  withCapture: (handler: unknown) => handler,
}));

import { POST } from "@/app/api/forecast/onboarding-audit/route";

const OWNER = { tenantId: "t-1", role: "OWNER", permissions: null };
const MEMBER = { tenantId: "t-1", role: "MEMBER", permissions: null };

beforeEach(() => {
  authState.session = { user: { id: "u-1" } };
  authState.membership = OWNER;
  runOnboardingAuditMock.mockReset();
  runOnboardingAuditMock.mockResolvedValue({ ran: true, tier: "nested", changed: true });
});

afterEach(() => vi.clearAllMocks());

describe("POST /api/forecast/onboarding-audit", () => {
  it("tunes the caller's own workspace", async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    // The tenant is the membership's, never anything a caller could supply.
    expect(runOnboardingAuditMock).toHaveBeenCalledWith("t-1");

    const body = await res.json();
    // Only the shop-facing facts — no tier, no engine routing.
    expect(body).toEqual({ ran: true, changed: true, reason: null });
    expect(body).not.toHaveProperty("tier");
  });

  it("refuses a caller with no session", async () => {
    authState.session = null;
    const res = await POST();
    expect(res.status).toBe(401);
    expect(runOnboardingAuditMock).not.toHaveBeenCalled();
  });

  it("refuses a caller with no workspace", async () => {
    authState.membership = null;
    const res = await POST();
    expect(res.status).toBe(403);
    expect(runOnboardingAuditMock).not.toHaveBeenCalled();
  });

  it("refuses a member — it can change how the forecast is produced", async () => {
    authState.membership = MEMBER;
    const res = await POST();
    expect(res.status).toBe(403);
    // The gate has to stop the work, not just the response.
    expect(runOnboardingAuditMock).not.toHaveBeenCalled();
  });

  it("passes a neutral reason through when a shop has too little history", async () => {
    // Not enough sales to tune against. A young shop, not a fault.
    runOnboardingAuditMock.mockResolvedValue({
      ran: false,
      tier: null,
      changed: false,
      reason: "insufficient_history",
    });
    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ran: false, changed: false, reason: "insufficient_history" });
  });
});
