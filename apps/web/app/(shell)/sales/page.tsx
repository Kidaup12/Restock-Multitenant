import type { Metadata } from "next";
import { ChartIcon } from "@/components/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = {
  title: "Sales data",
};

export default function SalesPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Sales data"
        description="Imports and sales history"
      />
      <EmptyState
        icon={<ChartIcon />}
        title="No sales data yet"
        description="Connected sources and uploaded sales history will appear here."
      />
    </div>
  );
}
