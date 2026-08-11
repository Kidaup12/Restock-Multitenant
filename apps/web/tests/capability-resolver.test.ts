import { describe, expect, it } from "vitest";
import type { LimitState } from "@wezesha/db";
import {
  resolveCapability,
  type CapabilityContext,
} from "../lib/capabilities";

/**
 * The composed resolver: the four gates evaluated in order, first blocking gate
 * wins. The load-bearing rule is plan-before-setup — a capability that is both
 * plan-locked and unset shows the plan lock, "the thing they'd buy first".
 */

const okDimension = { used: 1, max: 10, over: false };
const limits: LimitState = {
  products: okDimension,
  members: okDimension,
  orders30d: okDimension,
  anyOver: false,
  graceLeftDays: null,
};

type Overrides = {
  role?: "OWNER" | "ADMIN" | "MEMBER";
  permissions?: unknown;
  plan?: string | null;
  setupLevel?: 0 | 1 | 2 | 3;
  flags?: Record<string, boolean>;
};

function makeCtx(over: Overrides = {}): CapabilityContext {
  const level = over.setupLevel ?? 3;
  return {
    tenantId: "t1",
    plan: over.plan ?? "scale",
    membership: { role: over.role ?? "OWNER", permissions: over.permissions ?? null },
    config: over.flags ? { featureFlags: over.flags } : null,
    setup: {
      level,
      signals: {
        shopify: level >= 0,
        costs: level >= 1,
        suppliers: level >= 2,
        posOrMultiLocation: level >= 3,
      },
      nextUnlock: null,
    locationsToConfirm: 0,
    locationsPending: [],
    },
    limits,
  };
}

describe("all gates pass", () => {
  it("an owner on Scale at full depth can email a PO and run transfers", () => {
    const ctx = makeCtx();
    expect(resolveCapability(ctx, "email_po_to_supplier")).toEqual({
      available: true,
      blockedGate: null,
      message: "Email a PO to a supplier is available.",
    });
    expect(resolveCapability(ctx, "transfers").available).toBe(true);
  });

  it("run the forecast is the Level-0 promise — available from Shopify alone", () => {
    const ctx = makeCtx({ plan: "starter", setupLevel: 0 });
    const res = resolveCapability(ctx, "run_forecast");
    expect(res.available).toBe(true);
  });
});

describe("gate order", () => {
  it("role is checked first — a money-blind member cannot see costs", () => {
    const ctx = makeCtx({ role: "MEMBER" });
    const res = resolveCapability(ctx, "view_costs");
    expect(res.blockedGate).toBe("role");
    expect(res.message).toContain("permission");
  });

  it("role beats plan and setup when all three fail", () => {
    // Member (no view_costs) on starter (no budget_planner) at level 0 (< 1).
    const ctx = makeCtx({ role: "MEMBER", plan: "starter", setupLevel: 0 });
    expect(resolveCapability(ctx, "budget_planner").blockedGate).toBe("role");
  });

  it("plan is shown before setup — the spec's headline rule", () => {
    // Transfers on starter (locked) AND level 0 (unset). Plan wins.
    const ctx = makeCtx({ plan: "starter", setupLevel: 0 });
    const res = resolveCapability(ctx, "transfers");
    expect(res.blockedGate).toBe("plan");
    expect(res.message).toContain("unlock on Growth");
  });

  it("setup surfaces once the plan allows the feature", () => {
    // Transfers on growth (allowed) but only level 2 (needs 3).
    const ctx = makeCtx({ plan: "growth", setupLevel: 2 });
    const res = resolveCapability(ctx, "transfers");
    expect(res.blockedGate).toBe("setup");
    expect(res.message).toContain("Connect a POS feed or add a second location");
  });

  it("the feature switch is the last gate", () => {
    const ctx = makeCtx({ plan: "growth", setupLevel: 3, flags: { transfers: false } });
    const res = resolveCapability(ctx, "transfers");
    expect(res.blockedGate).toBe("feature");
    expect(res.message).toContain("switched off");
  });
});

describe("per-gate messages", () => {
  it("the plan message carries the value line and the target tier", () => {
    const ctx = makeCtx({ plan: "starter" });
    const res = resolveCapability(ctx, "email_po_to_supplier");
    expect(res.blockedGate).toBe("plan");
    expect(res.message).toBe(
      "Group a buy list into POs and email suppliers in one click — unlock on Growth.",
    );
  });

  it("the setup message names the data to add", () => {
    // Owner on Scale (plan ok), but only level 1 → email PO needs level 2.
    const ctx = makeCtx({ plan: "scale", setupLevel: 1 });
    const res = resolveCapability(ctx, "email_po_to_supplier");
    expect(res.blockedGate).toBe("setup");
    expect(res.message).toBe("Assign suppliers and lead times to email a PO to a supplier.");
  });

  it("view costs is role + setup only (no plan lock on a cost feature)", () => {
    const ctx = makeCtx({ setupLevel: 0 }); // owner, plan ok, but no cost data
    const res = resolveCapability(ctx, "view_costs");
    expect(res.blockedGate).toBe("setup");
    expect(res.message).toBe("Add product costs to see costs and margins.");
  });
});
