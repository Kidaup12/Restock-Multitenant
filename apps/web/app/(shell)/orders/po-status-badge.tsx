import { Badge } from "@/components/ui/badge";

/** One status → badge mapping for every PO surface (list, detail, print). */
const statuses: Record<string, { label: string; tone: "neutral" | "accent" | "positive" | "warning" | "negative" }> = {
  draft: { label: "Draft", tone: "neutral" },
  sent: { label: "Sent", tone: "accent" },
  partially_received: { label: "Partly received", tone: "warning" },
  received: { label: "Received", tone: "positive" },
  cancelled: { label: "Cancelled", tone: "negative" },
  // QB evidence track — dormant until the read-back feed lands.
  awaiting_qb: { label: "Awaiting entry", tone: "warning" },
  confirmed: { label: "Confirmed", tone: "accent" },
};

export function PoStatusBadge({ status }: { status: string }) {
  const s = statuses[status] ?? { label: status, tone: "neutral" as const };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}
