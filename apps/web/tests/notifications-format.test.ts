import { describe, expect, it } from "vitest";
import { kindTone, relativeTime } from "../lib/notifications/format";

describe("relativeTime", () => {
  const now = Date.parse("2026-07-23T12:00:00.000Z");
  const at = (iso: string) => relativeTime(iso, now);

  it("buckets by age", () => {
    expect(at("2026-07-23T11:59:40.000Z")).toBe("just now");
    expect(at("2026-07-23T11:55:00.000Z")).toBe("5m ago");
    expect(at("2026-07-23T09:00:00.000Z")).toBe("3h ago");
    expect(at("2026-07-21T12:00:00.000Z")).toBe("2d ago");
    expect(at("2026-06-12T12:00:00.000Z")).toBe("12 Jun");
  });

  it("treats future and invalid timestamps as just now", () => {
    expect(at("2026-07-23T12:05:00.000Z")).toBe("just now");
    expect(at("not-a-date")).toBe("just now");
  });
});

describe("kindTone", () => {
  it("maps known kinds and defaults the rest", () => {
    expect(kindTone("sync_failed")).toBe("negative");
    expect(kindTone("shopify_reconnect")).toBe("warning");
    expect(kindTone("shopify_uninstalled")).toBe("warning");
    // A new product with no cost stays off the buy list until someone sets one,
    // so this is something to act on — a kind missing from here renders neutral
    // and reads as news rather than a job.
    expect(kindTone("catalogue_review")).toBe("warning");
    expect(kindTone("something_else")).toBe("neutral");
  });
});
