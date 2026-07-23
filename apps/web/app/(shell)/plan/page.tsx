import type { Metadata } from "next";
import { CalendarIcon } from "@/components/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = {
  title: "Plan",
};

export default function PlanPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Plan"
        description="Weekly replenishment planning"
      />
      <EmptyState
        icon={<CalendarIcon />}
        title="Nothing planned yet"
        description="Suggested buy lists and supplier order planning will live here."
      />
    </div>
  );
}
