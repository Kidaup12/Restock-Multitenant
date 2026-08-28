import { describe, it, expect } from "vitest";
import {
  segmentChampionsToClasses,
  engineModelToDemandMethod,
} from "../src/onboarding-audit";
import type { RoutingTable } from "../src/engine-client";

// The exact routing table the real audit-engine produced for the synthetic
// "full" scenario in the e2e run (fetched from GET /routing).
const REAL_ROUTING: RoutingTable = {
  status: "provisional",
  validated: true,
  default_champion: "M5",
  floor_model: "M2",
  segments: {
    AX: { champion: "M6", fallback: "M5", val_wape: 0.176 },
    AY: { champion: "M9", fallback: "M5", val_wape: 0.2082 },
    BX: { champion: "M6", fallback: "M5", val_wape: 0.176 },
    CX: { champion: "M6", fallback: "M5", val_wape: 0.176 },
    CY: { champion: "M2", fallback: "M5", val_wape: 0.2529 },
    dormant: { champion: "M9", fallback: "M5", val_wape: 0.2082 },
    intermittent: { champion: "M9", fallback: "M5", val_wape: 0.2082 },
  },
};

describe("engineModelToDemandMethod", () => {
  it("maps intermittent/reactive models to recent_heavy", () => {
    expect(engineModelToDemandMethod("M9")).toBe("recent_heavy");
    expect(engineModelToDemandMethod("M8")).toBe("recent_heavy");
  });
  it("maps smoothers/median/naive to run_rate", () => {
    expect(engineModelToDemandMethod("M5")).toBe("run_rate");
    expect(engineModelToDemandMethod("M6")).toBe("run_rate"); // SES
    expect(engineModelToDemandMethod("M2")).toBe("run_rate"); // seasonal naive
    expect(engineModelToDemandMethod("C1")).toBe("run_rate");
  });
  it("defaults unknown ids to run_rate", () => {
    expect(engineModelToDemandMethod("ZZZ")).toBe("run_rate");
  });
});

describe("segmentChampionsToClasses on the REAL engine output", () => {
  const classes = segmentChampionsToClasses(REAL_ROUTING);
  it("A = lowest-val_wape A* segment (AX:M6=0.176 beats AY:M9=0.2082) -> run_rate", () => {
    expect(classes.A).toBe("run_rate");
  });
  it("B = BX:M6 -> run_rate", () => {
    expect(classes.B).toBe("run_rate");
  });
  it("C = lowest-val_wape C* segment (CX:M6=0.176 beats CY:M2) -> run_rate", () => {
    expect(classes.C).toBe("run_rate");
  });
  it("intermittent/dormant do NOT pollute A/B/C", () => {
    // they don't start with A/B/C, so they're ignored by the class collapse
    expect(Object.keys(classes).sort()).toEqual(["A", "B", "C"]);
  });
});

describe("segmentChampionsToClasses picks recent_heavy when an intermittent model wins its class", () => {
  const routing: RoutingTable = {
    ...REAL_ROUTING,
    segments: {
      AX: { champion: "M9", fallback: "M5", val_wape: 0.10 }, // intermittent wins A
      BX: { champion: "M5", fallback: "M5", val_wape: 0.20 },
    },
  };
  const classes = segmentChampionsToClasses(routing);
  it("A -> recent_heavy (M9)", () => expect(classes.A).toBe("recent_heavy"));
  it("B -> run_rate (M5)", () => expect(classes.B).toBe("run_rate"));
  it("C falls back to ALL/default when no C* segment", () => {
    // no C* and no ALL segment -> CHAMPION_DEFAULT (run_rate)
    expect(classes.C).toBe("run_rate");
  });
});
