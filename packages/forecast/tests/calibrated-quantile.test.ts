import { describe, it, expect } from "vitest";
import { countQuantile, calibratedCover } from "../src/calibrated-quantile";

describe("countQuantile", () => {
  it("returns 0 for no demand", () => {
    expect(countQuantile(0, 0, 0.95)).toBe(0);
  });

  it("matches Poisson quantiles when not over-dispersed", () => {
    // Poisson(10): median ~10, p95 ~15.
    expect(countQuantile(10, 10, 0.5)).toBeGreaterThanOrEqual(9);
    expect(countQuantile(10, 10, 0.5)).toBeLessThanOrEqual(11);
    const p95 = countQuantile(10, 10, 0.95);
    expect(p95).toBeGreaterThanOrEqual(14);
    expect(p95).toBeLessThanOrEqual(16);
  });

  it("gives a FATTER tail than Poisson when over-dispersed (the whole point)", () => {
    const poisson = countQuantile(10, 10, 0.95);
    const overdispersed = countQuantile(10, 30, 0.95); // var 3× mean
    expect(overdispersed).toBeGreaterThan(poisson);
  });

  it("is monotonic in tau", () => {
    const q50 = countQuantile(10, 30, 0.5);
    const q90 = countQuantile(10, 30, 0.9);
    const q99 = countQuantile(10, 30, 0.99);
    expect(q90).toBeGreaterThanOrEqual(q50);
    expect(q99).toBeGreaterThanOrEqual(q90);
  });
});

describe("calibratedCover", () => {
  it("scales with the protection horizon", () => {
    const short = calibratedCover({ dailyMean: 2, dailyVar: 6, horizonDays: 7, tau: 0.95 });
    const long = calibratedCover({ dailyMean: 2, dailyVar: 6, horizonDays: 21, tau: 0.95 });
    expect(long).toBeGreaterThan(short);
  });

  it("covers at least the mean demand over the horizon at a high service level", () => {
    const cover = calibratedCover({ dailyMean: 3, dailyVar: 12, horizonDays: 21, tau: 0.95 });
    expect(cover).toBeGreaterThanOrEqual(3 * 21); // p95 >= mean
  });

  it("bias factor lifts a known-light forecast", () => {
    const base = calibratedCover({ dailyMean: 2, dailyVar: 6, horizonDays: 21, tau: 0.95, biasFactor: 1 });
    const lifted = calibratedCover({ dailyMean: 2, dailyVar: 6, horizonDays: 21, tau: 0.95, biasFactor: 1.2 });
    expect(lifted).toBeGreaterThan(base);
  });

  it("dispersion floor fattens the tail for a thin variance estimate", () => {
    const thin = calibratedCover({ dailyMean: 2, dailyVar: 0.1, horizonDays: 21, tau: 0.95, dispersionFloor: 1 });
    const floored = calibratedCover({ dailyMean: 2, dailyVar: 0.1, horizonDays: 21, tau: 0.95, dispersionFloor: 4 });
    expect(floored).toBeGreaterThanOrEqual(thin);
  });
});
