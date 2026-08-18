import { describe, it, expect } from "vitest";
import { changedChampionClasses, methodChangeBody } from "../src/backtest-run";

describe("changedChampionClasses", () => {
  const all = (m: "run_rate" | "recent_heavy") => ({ A: m, B: m, C: m } as const);

  it("is empty when nothing moved", () => {
    expect(changedChampionClasses(all("run_rate"), all("run_rate"))).toEqual([]);
  });

  it("lists the class that adopted a new method", () => {
    expect(
      changedChampionClasses(
        { A: "run_rate", B: "run_rate", C: "run_rate" },
        { A: "recent_heavy", B: "run_rate", C: "run_rate" }
      )
    ).toEqual(["A"]);
  });

  it("catches a class reverting to the default too", () => {
    expect(
      changedChampionClasses(
        { A: "recent_heavy", B: "run_rate", C: "run_rate" },
        { A: "run_rate", B: "run_rate", C: "run_rate" }
      )
    ).toEqual(["A"]);
  });

  it("lists every class that moved", () => {
    expect(
      changedChampionClasses(all("run_rate"), all("recent_heavy"))
    ).toEqual(["A", "B", "C"]);
  });
});

describe("methodChangeBody", () => {
  it("names one group in plain words, no method name", () => {
    const body = methodChangeBody(["A"]);
    expect(body).toContain("your bestsellers");
    expect(body).not.toMatch(/run_rate|recent_heavy/);
  });

  it("joins several groups readably", () => {
    expect(methodChangeBody(["A", "B", "C"])).toContain(
      "your bestsellers, your steady sellers and your slower movers"
    );
  });
});
