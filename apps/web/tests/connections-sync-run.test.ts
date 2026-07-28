import { describe, expect, it } from "vitest";
import { STALE_AFTER_MS, summarise, toSyncRunView, type SyncRunRow } from "@/lib/shopify/sync-run";

/**
 * The mapper is what makes a cold page load correct mid-run, so the case that
 * matters most is the one no happy path produces: a worker that died holding a
 * `running` row, which must never render as an eternal spinner.
 */

const NOW = new Date("2026-07-28T12:00:00.000Z");

function row(over: Partial<SyncRunRow> = {}): SyncRunRow {
  return {
    id: "run_1",
    status: "running",
    phase: "products",
    phaseIndex: 1,
    phaseTotal: 3,
    itemsDone: 120,
    itemsTotal: 500,
    counts: null,
    error: null,
    startedAt: new Date("2026-07-28T11:58:00.000Z"),
    finishedAt: null,
    updatedAt: new Date("2026-07-28T11:59:50.000Z"),
    ...over,
  };
}

describe("toSyncRunView", () => {
  it("returns null when no run has ever happened", () => {
    expect(toSyncRunView(null, NOW)).toBeNull();
  });

  it("carries a live run's phase and counts through", () => {
    const view = toSyncRunView(row(), NOW)!;
    expect(view).toMatchObject({
      status: "running",
      phase: "products",
      phaseIndex: 1,
      phaseTotal: 3,
      itemsDone: 120,
      itemsTotal: 500,
      durationSec: null,
    });
  });

  it("reports a finished run with its duration and summary", () => {
    const view = toSyncRunView(
      row({
        status: "ok",
        phase: null,
        finishedAt: new Date("2026-07-28T12:02:12.000Z"),
        counts: {
          products: { written: 5310, failed: 0 },
          inventory: { locations: 3, levels: 4102 },
          orders: { salesDays: 812 },
        },
      }),
      NOW
    )!;
    expect(view.status).toBe("ok");
    expect(view.durationSec).toBe(252); // 11:58:00 → 12:02:12
    expect(view.summary).toBe("5,310 products · 3 locations · 812 sales days");
    expect(view.finishedAt).toBe("2026-07-28 12:02 UTC");
  });

  it("keeps a failed run's error", () => {
    const view = toSyncRunView(row({ status: "failed", error: "Shopify auth failed (401)" }), NOW)!;
    expect(view).toMatchObject({ status: "failed", error: "Shopify auth failed (401)" });
  });

  it("calls a running row stalled once nothing has touched it for the stale window", () => {
    const dead = row({ updatedAt: new Date(NOW.getTime() - STALE_AFTER_MS - 1000) });
    expect(toSyncRunView(dead, NOW)!.status).toBe("stalled");
  });

  it("does not call a run stalled while ticks are still arriving", () => {
    const alive = row({ updatedAt: new Date(NOW.getTime() - STALE_AFTER_MS + 1000) });
    expect(toSyncRunView(alive, NOW)!.status).toBe("running");
  });

  it("never marks a finished run stalled, however old it is", () => {
    const old = row({
      status: "ok",
      finishedAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(toSyncRunView(old, NOW)!.status).toBe("ok");
  });
});

describe("summarise", () => {
  it("is null when the run wrote nothing worth naming", () => {
    expect(summarise(null)).toBeNull();
    expect(summarise({})).toBeNull();
  });

  it("names failures only when there were some", () => {
    expect(summarise({ products: { written: 2, failed: 0 } })).toBe("2 products");
    expect(summarise({ products: { written: 2, failed: 1 } })).toBe("2 products · 1 failure");
  });

  it("singularises", () => {
    expect(summarise({ inventory: { locations: 1 }, orders: { salesDays: 1 } })).toBe(
      "1 location · 1 sales day"
    );
  });
});
