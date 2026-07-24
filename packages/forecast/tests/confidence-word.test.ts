import { describe, it, expect } from "vitest";
import {
  confidenceWord,
  leastConfident,
  type ConfidenceSignals,
} from "../src/confidence-word";

const clean: ConfidenceSignals = {
  historyDays: 120,
  cv: 0.3,
  stockoutGapShare: 0,
  promoContaminated: false,
  coldStart: false,
};

describe("confidenceWord bands", () => {
  it("a full season of steady, in-stock, promo-free demand is 'sure'", () => {
    expect(confidenceWord(clean)).toBe("sure");
  });

  it("cold start is always a guess, however much else looks fine", () => {
    expect(confidenceWord({ ...clean, coldStart: true })).toBe("guessing");
  });

  it("under three weeks of history is a guess", () => {
    expect(confidenceWord({ ...clean, historyDays: 20 })).toBe("guessing");
    expect(confidenceWord({ ...clean, historyDays: 21 })).not.toBe("guessing");
  });

  it("variance at or above the mean (cv >= 1) is a guess", () => {
    expect(confidenceWord({ ...clean, cv: 1.0 })).toBe("guessing");
    expect(confidenceWord({ ...clean, cv: 0.99 })).not.toBe("guessing");
  });

  it("shelves empty 40%+ of the window is a guess", () => {
    expect(confidenceWord({ ...clean, stockoutGapShare: 0.4 })).toBe("guessing");
    expect(confidenceWord({ ...clean, stockoutGapShare: 0.39 })).not.toBe("guessing");
  });

  it("a running promo blocks 'sure' but not 'fairly sure'", () => {
    expect(confidenceWord({ ...clean, promoContaminated: true })).toBe("fairly_sure");
  });

  it("real but short-ish history lands on 'fairly sure'", () => {
    expect(confidenceWord({ ...clean, historyDays: 45 })).toBe("fairly_sure");
  });

  it("some variance below the guess line still reads 'fairly sure'", () => {
    expect(confidenceWord({ ...clean, cv: 0.7 })).toBe("fairly_sure");
  });

  it("a season with a little stockout noise is 'fairly sure', not 'sure'", () => {
    expect(confidenceWord({ ...clean, stockoutGapShare: 0.2 })).toBe("fairly_sure");
  });
});

describe("leastConfident", () => {
  it("returns the less certain of two words", () => {
    expect(leastConfident("sure", "guessing")).toBe("guessing");
    expect(leastConfident("sure", "fairly_sure")).toBe("fairly_sure");
    expect(leastConfident("fairly_sure", "sure")).toBe("fairly_sure");
    expect(leastConfident("sure", "sure")).toBe("sure");
  });
});
