import { Badge } from "@/components/ui/badge";
import type { QbEvidence } from "@/lib/data/orders";

/**
 * What the books say about an order that was sent.
 *
 * The nightly read-back has written this evidence since the QuickBooks feed
 * landed and nothing has ever shown it. The one that matters is `missing`: an
 * order went to a supplier, the grace period passed, and no matching Bill or PO
 * exists — so stock is committed and the accounts do not know. That is how an
 * invoice gets paid twice, or never.
 *
 * It is evidence, never a gate. An order is real because it was sent; the books
 * catching up is a separate fact about the books.
 */

const day = (date: Date) =>
  date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });

export function QbEvidenceBadge({ qb }: { qb: QbEvidence }) {
  switch (qb.state) {
    case "confirmed":
      return (
        <Badge tone="positive" title={`Matched in QuickBooks on ${day(qb.at)}${qb.docRef ? ` · ${qb.docRef}` : ""}`}>
          In the books
        </Badge>
      );
    case "missing":
      return (
        <Badge tone="negative" title="Sent, but no matching bill or purchase order in QuickBooks. Check it was entered.">
          Not in the books
        </Badge>
      );
    case "suggested":
      return (
        <Badge tone="warning" title={`A similar QuickBooks document exists (${qb.label}) but not close enough to confirm. Check it by hand.`}>
          Possible match
        </Badge>
      );
    case "pending":
      // Deliberately quiet: an order sent this morning is not a problem, and a
      // badge on every fresh order would train people to ignore the row.
      return null;
    case "not_sent":
      return null;
  }
}
