import { describe, expect, it } from "vitest";
import { recommendedQty } from "@wezesha/forecast";
import { byOrderDeadline, whatIfSizeDays } from "../lib/data/cover-horizon";

/**
 * The budget planner's cover target is days of stock AFTER the delivery lands.
 *
 * It used to be max(cover, lead): a 30-day supplier asked for 21 days of cover
 * bought only enough to reach the delivery, which then landed on an empty shelf
 * — less than the plain nightly plan (lead + a week) bought for the same item.
 */
describe("cover horizon is lead time plus cover", () => {
  it("adds the measured lead on top of the cover asked for", () => {
    expect(whatIfSizeDays(21, 30)).toBe(51);
    expect(whatIfSizeDays(21, 3)).toBe(24);
  });

  it("an unknown lead adds nothing — sizing never rests on a guess", () => {
    expect(whatIfSizeDays(21, null)).toBe(21);
  });

  it("worked example: 2/day, 10 on hand, 30-day lead, 21 days cover leaves 21 days on arrival", () => {
    const rate = 2;
    const qty = recommendedQty({
      finalForecast30d: rate * 30,
      safetyStock: 0,
      currentStock: 10,
      onOrder: 0,
      coverDays: whatIfSizeDays(21, 30),
    });
    expect(qty).toBe(92);
    // Stock when the delivery lands (ignoring lost sales during a stockout):
    const onArrival = 10 + qty - rate * 30;
    expect(onArrival / rate).toBe(21);
  });

  it("buys at least what the plain plan (lead + 7) would for the same item", () => {
    const base = { finalForecast30d: 60, safetyStock: 0, currentStock: 10, onOrder: 0 };
    const plain = recommendedQty({ ...base, coverDays: 30 + 7 });
    const withCover = recommendedQty({ ...base, coverDays: whatIfSizeDays(21, 30) });
    expect(withCover).toBeGreaterThan(plain);
  });

  it("stock already on order is subtracted", () => {
    const base = { finalForecast30d: 60, safetyStock: 0, currentStock: 10, coverDays: whatIfSizeDays(21, 30) };
    expect(recommendedQty({ ...base, onOrder: 40 })).toBe(recommendedQty({ ...base, onOrder: 0 }) - 40);
  });
});

describe("budget funds the soonest order deadline first", () => {
  it("a slow supplier's line that is late to order beats a fast one that empties sooner", () => {
    // Empties in 20 days but the supplier takes 60: 40 days late to order.
    const slow = { daysLeftToOrder: 20 - 60 };
    // Empties in 10 days, supplier takes 2: 8 days to spare.
    const fast = { daysLeftToOrder: 10 - 2 };
    expect([fast, slow].sort(byOrderDeadline)[0]).toBe(slow);
  });

  it("everything already due today ties, so the next keys decide", () => {
    expect(byOrderDeadline({ daysLeftToOrder: -40 }, { daysLeftToOrder: 0 })).toBe(0);
  });
});
