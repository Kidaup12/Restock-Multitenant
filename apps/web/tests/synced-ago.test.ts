import { describe, expect, it } from "vitest";
import { isStale, syncedAgo } from "@/lib/sync/staleness";

/**
 * "Synced 7h ago" in the rail.
 *
 * The connection banner answers "is this broken?" and only once a store has
 * been silent for a full day. A shop deciding what to buy asks a different
 * question on every screen — "is what I am looking at current?" — and until
 * now nothing on the page answered it.
 */

const at = (msAgo: number) => new Date(1_000_000_000_000 - msAgo);
const NOW = 1_000_000_000_000;

describe("synced ago", () => {
  it("reads in the units a person would use", () => {
    expect(syncedAgo(at(30_000), NOW)).toBe("just now");
    expect(syncedAgo(at(5 * 60_000), NOW)).toBe("5m ago");
    expect(syncedAgo(at(7 * 3_600_000), NOW)).toBe("7h ago");
    expect(syncedAgo(at(3 * 86_400_000), NOW)).toBe("3d ago");
  });

  it("rolls over at each unit boundary, not near it", () => {
    // Samples in the middle of a unit cannot catch an off-by-one at the edge —
    // a "< 24" that should be "<= 24", or minutes that never became an hour.
    const M = 60_000, H = 3_600_000, D = 86_400_000;
    expect(syncedAgo(at(59 * M), NOW), "59 minutes should still be minutes").toBe("59m ago");
    expect(syncedAgo(at(60 * M), NOW), "60 minutes should read as an hour").toBe("1h ago");
    expect(syncedAgo(at(23 * H), NOW), "23 hours should still be hours").toBe("23h ago");
    expect(syncedAgo(at(24 * H), NOW), "24 hours should read as a day").toBe("1d ago");
    expect(syncedAgo(at(D - 1), NOW), "just under a day is still hours").toBe("23h ago");
  });

  it("says nothing when nothing has ever arrived", () => {
    // A store that has never synced is not "0m ago" — the setup card and the
    // banner both handle that state, and inventing a duration would paper over
    // it with something that reads healthy.
    expect(syncedAgo(null, NOW)).toBeNull();
  });

  it("keeps reporting after the staleness threshold", () => {
    // The two are independent: the banner fires at a day, and the rail still
    // has to say how long it has been. A line that went blank exactly when the
    // news got bad would be worse than no line.
    const twoDays = at(2 * 86_400_000);
    expect(isStale(twoDays, NOW)).toBe(true);
    expect(syncedAgo(twoDays, NOW), "the rail went quiet once the store did").toBe("2d ago");
  });

  it("never reports a negative age from a clock skew", () => {
    expect(syncedAgo(new Date(NOW + 60_000), NOW)).toBe("just now");
  });
});
