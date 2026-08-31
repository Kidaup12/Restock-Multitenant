import { describe, expect, it } from "vitest";
import { matchPurchaseOrders, type LocalPurchaseOrder } from "../src/match";
import type { QuickBooksPurchaseOrder } from "../src/purchase-orders";

/**
 * What may be treated as evidence, and what may only be offered as a hint.
 *
 * The asymmetry is the whole design: confirming the wrong document tells a shop
 * an order is safely on its books when it is not — which is exactly the failure
 * the phantom check exists to catch, manufactured by the check itself. So the
 * document number confirms and nothing else does.
 */

const NOW = new Date("2026-08-31T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

const ours = (over: Partial<LocalPurchaseOrder> = {}): LocalPurchaseOrder => ({
  id: "local-1",
  poNumber: "PO-1001",
  vendor: "Amara Supplies",
  subtotalKes: 10_000,
  sentAt: daysAgo(10),
  ...over,
});

const theirs = (over: Partial<QuickBooksPurchaseOrder> = {}): QuickBooksPurchaseOrder => ({
  id: "qb-1",
  docNumber: "PO-1001",
  totalAmt: 10_000,
  txnDate: "2026-08-21",
  vendorName: "Amara Supplies",
  ...over,
});

describe("matching our purchase orders against a company's books", () => {
  it("confirms on the document number, ignoring case and spacing", () => {
    const res = matchPurchaseOrders([ours()], [theirs({ docNumber: " po-1001 " })], { now: NOW });
    expect(res.confirmed).toEqual([{ localId: "local-1", qbId: "qb-1", qbDocNumber: " po-1001 " }]);
    expect(res.phantoms).toEqual([]);
    // A confirmed document is not also "something you raised elsewhere".
    expect(res.external).toEqual([]);
  });

  it("does NOT confirm on amount and supplier alone — it only suggests", () => {
    // The case that would be tempting to auto-confirm and must never be.
    const res = matchPurchaseOrders([ours()], [theirs({ docNumber: "1042" })], { now: NOW });
    expect(res.confirmed).toEqual([]);
    expect(res.suggestions).toHaveLength(1);
    expect(res.suggestions[0]!.qbId).toBe("qb-1");
  });

  it("leaves a merely-suggested document in the external list", () => {
    // It is still unaccounted for until a person agrees. Hiding it on a guess
    // is how a genuinely external order goes unnoticed.
    const res = matchPurchaseOrders([ours()], [theirs({ docNumber: "1042" })], { now: NOW });
    expect(res.external.map((d) => d.id)).toEqual(["qb-1"]);
  });

  it("reports what is in the books that we never raised", () => {
    const res = matchPurchaseOrders(
      [ours()],
      [theirs(), theirs({ id: "qb-2", docNumber: "QB-500", totalAmt: 7_500, vendorName: "Other Co" })],
      { now: NOW },
    );
    expect(res.confirmed.map((m) => m.qbId)).toEqual(["qb-1"]);
    expect(res.external.map((d) => d.id)).toEqual(["qb-2"]);
  });

  it("flags an order missing from the books once it is old enough", () => {
    const res = matchPurchaseOrders([ours({ sentAt: daysAgo(10) })], [], { now: NOW });
    expect(res.phantoms.map((p) => p.id)).toEqual(["local-1"]);
  });

  it("does not flag one sent yesterday — a delay is the likelier explanation", () => {
    const res = matchPurchaseOrders([ours({ sentAt: daysAgo(1) })], [], { now: NOW });
    expect(res.phantoms).toEqual([]);
  });

  it("never flags an order that was never sent", () => {
    // A draft is not expected in the books at all; flagging it would be noise
    // on every order a shop is still writing.
    const res = matchPurchaseOrders([ours({ sentAt: null })], [], { now: NOW });
    expect(res.phantoms).toEqual([]);
  });

  it("refuses to guess when two documents share our number", () => {
    // Two candidates is no evidence at all. First wins for the match, and the
    // second stays external rather than being silently absorbed.
    const res = matchPurchaseOrders(
      [ours()],
      [theirs({ id: "qb-a" }), theirs({ id: "qb-b" })],
      { now: NOW },
    );
    expect(res.confirmed).toHaveLength(1);
    expect(res.external.map((d) => d.id)).toEqual(["qb-b"]);
  });

  it("does not suggest across suppliers, even at the same amount", () => {
    const res = matchPurchaseOrders(
      [ours()],
      [theirs({ docNumber: "1042", vendorName: "Someone Else" })],
      { now: NOW },
    );
    expect(res.suggestions).toEqual([]);
  });

  it("does not suggest on a materially different amount", () => {
    const res = matchPurchaseOrders(
      [ours()],
      [theirs({ docNumber: "1042", totalAmt: 13_000 })],
      { now: NOW },
    );
    expect(res.suggestions).toEqual([]);
  });

  it("does not claim a zero-amount document as a lookalike", () => {
    // A blank draft in the books would otherwise match every order we have.
    const res = matchPurchaseOrders(
      [ours({ subtotalKes: 0 })],
      [theirs({ docNumber: "1042", totalAmt: 0 })],
      { now: NOW },
    );
    expect(res.suggestions).toEqual([]);
  });

  it("does not lend one QuickBooks document to two of our orders", () => {
    const res = matchPurchaseOrders(
      [ours({ id: "local-1" }), ours({ id: "local-2", poNumber: "PO-1002" })],
      [theirs({ docNumber: "PO-1001" })],
      { now: NOW },
    );
    expect(res.confirmed).toHaveLength(1);
    expect(res.suggestions).toEqual([]); // qb-1 already claimed by local-1
  });
});
