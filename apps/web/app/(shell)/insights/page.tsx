import type { Metadata } from "next";
import { BulbIcon } from "@/components/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = {
  title: "Insights",
};

export default function InsightsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Insights"
        description="Trends, winners, and slow movers"
      />
      <EmptyState
        icon={<BulbIcon />}
        title="Insights coming soon"
        description="Sell-through trends and product performance analysis will live here."
      />
    </div>
  );
}
