import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { qbEvidenceFor } from "@/lib/data/orders";
import { QbEvidenceBadge } from "@/app/(shell)/orders/qb-evidence-badge";

/**
 * What the books say about an order that was sent.
 *
 * The nightly read-back has written this evidence since the QuickBooks feed
 * landed and nothing ever showed it — built, not surfaced. The state worth the
 * whole feature is `missing`: an order went to a supplier, the grace period
 * passed, and no matching bill exists, so stock is committed and the accounts
 * do not know.
 */

const po = (over: Partial<Parameters<typeof qbEvidenceFor>[0]> = {}) => ({
  status: "sent",
  sentAt: new Date("2026-08-01T09:00:00Z"),
  qbConfirmedAt: null,
  qbDocRef: null,
  qbSuggestion: null,
  needsAttention: false,
  ...over,
});

describe("quickbooks evidence", () => {
  it("reads a match as confirmed, and keeps the reference for the audit", () => {
    const e = qbEvidenceFor(po({ qbConfirmedAt: new Date("2026-08-03T00:00:00Z"), qbDocRef: "Bill 1042" }));
    expect(e).toEqual({ state: "confirmed", at: new Date("2026-08-03T00:00:00Z"), docRef: "Bill 1042" });
  });

  it("flags a sent order the books have never seen", () => {
    expect(qbEvidenceFor(po({ needsAttention: true })).state).toBe("missing");
  });

  it("never lets a lookalike stand as proof", () => {
    // A fuzzy match that auto-confirmed would be worse than silence: it would
    // say the money is accounted for when nobody has checked.
    const e = qbEvidenceFor(po({ qbSuggestion: "Bill 1042" }));
    expect(e.state, "a lookalike was treated as confirmation").toBe("suggested");
  });

  it("stays quiet on an order that was never sent", () => {
    // A draft is not missing from the books; it was never expected there.
    expect(qbEvidenceFor(po({ status: "draft", sentAt: null, needsAttention: true })).state).toBe("not_sent");
  });

  it("does not call a cancelled order a phantom", () => {
    // It was sent, then withdrawn. The books being silent is correct.
    expect(
      qbEvidenceFor(po({ status: "cancelled", needsAttention: true })).state,
      "a cancelled order was reported as missing from the books",
    ).toBe("not_sent");
  });

  it("confirmation outranks every other signal", () => {
    // A stale needsAttention flag must not survive a later match.
    expect(
      qbEvidenceFor(po({ qbConfirmedAt: new Date(), needsAttention: true, qbSuggestion: "x" })).state,
      "a confirmed order still read as missing",
    ).toBe("confirmed");
  });

  it("says nothing about an order sent this morning", () => {
    // Inside the grace period. A badge on every fresh order trains people to
    // ignore the row, which is how the one that matters gets missed.
    expect(qbEvidenceFor(po()).state).toBe("pending");
    expect(renderToStaticMarkup(<QbEvidenceBadge qb={{ state: "pending" }} />)).toBe("");
    expect(renderToStaticMarkup(<QbEvidenceBadge qb={{ state: "not_sent" }} />)).toBe("");
  });

  it("names the states in the shop's words, not QuickBooks'", () => {
    const missing = renderToStaticMarkup(<QbEvidenceBadge qb={{ state: "missing" }} />);
    expect(missing).toContain("Not in the books");
    expect(missing, "the badge does not say what to do about it").toContain("Check it was entered");
    expect(renderToStaticMarkup(
      <QbEvidenceBadge qb={{ state: "confirmed", at: new Date("2026-08-03T00:00:00Z"), docRef: "Bill 1042" }} />,
    )).toContain("In the books");
  });
});
