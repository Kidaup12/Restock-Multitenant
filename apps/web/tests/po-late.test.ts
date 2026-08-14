import { describe, expect, it } from "vitest";
import { isPoLate } from "../lib/po/po-model";

/** Overdue deliveries: a sent PO whose promised day has passed with stock still
 *  outstanding. Every "overdue" elsewhere in the product means the last safe day
 *  to order has passed — this one is about the supplier, not the buyer. */

const at = (iso: string) => new Date(iso);
const po = (over: Partial<Parameters<typeof isPoLate>[0]>) => ({
  status: "sent",
  expectedAt: at("2026-07-10T09:00:00"),
  receivedAt: null,
  ...over,
});

describe("isPoLate", () => {
  it("flags a sent PO once its promised day has passed", () => {
    expect(isPoLate(po({}), at("2026-07-11T00:00:00"))).toBe(true);
    expect(isPoLate(po({}), at("2026-07-17T09:00:00"))).toBe(true);
  });

  it("gives the supplier the whole promised day", () => {
    // The ETA carries the send time of day (sentAt + lead days), but the shop
    // is only ever shown the date — a delivery due today isn't late at 09:01.
    expect(isPoLate(po({}), at("2026-07-10T09:01:00"))).toBe(false);
    expect(isPoLate(po({}), at("2026-07-10T23:59:59"))).toBe(false);
    expect(isPoLate(po({}), at("2026-07-11T00:00:00"))).toBe(true);
  });

  it("is not late before the promised day", () => {
    expect(isPoLate(po({}), at("2026-07-08T09:00:00"))).toBe(false);
  });

  it("clears once the delivery is complete, early or late", () => {
    const early = po({ status: "received", receivedAt: at("2026-07-08T09:00:00") });
    const late = po({ status: "received", receivedAt: at("2026-07-20T09:00:00") });
    expect(isPoLate(early, at("2026-07-30T09:00:00"))).toBe(false);
    // Arrived a week after the ETA — history the supplier scorecard grades, not
    // something the shop can still chase.
    expect(isPoLate(late, at("2026-07-30T09:00:00"))).toBe(false);
  });

  it("keeps a partially received PO late for the outstanding units", () => {
    const partial = po({ status: "partially_received", receivedAt: null });
    expect(isPoLate(partial, at("2026-07-15T09:00:00"))).toBe(true);
    expect(isPoLate(partial, at("2026-07-08T09:00:00"))).toBe(false);
  });

  it("never calls a PO late without a promised date", () => {
    expect(isPoLate(po({ expectedAt: null }), at("2030-01-01T00:00:00"))).toBe(false);
    expect(
      isPoLate(po({ status: "partially_received", expectedAt: null }), at("2030-01-01T00:00:00"))
    ).toBe(false);
  });

  it("ignores POs nobody is waiting on", () => {
    // A draft was never sent — no supplier ever promised anything.
    expect(isPoLate(po({ status: "draft" }), at("2026-07-20T09:00:00"))).toBe(false);
    expect(isPoLate(po({ status: "cancelled" }), at("2026-07-20T09:00:00"))).toBe(false);
  });
});
