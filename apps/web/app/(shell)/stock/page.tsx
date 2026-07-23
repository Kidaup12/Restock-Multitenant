import type { Metadata } from "next";
import { BoxIcon } from "@/components/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = {
  title: "Stock",
};

export default function StockPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Stock"
        description="Every tracked product and its position"
      />
      <EmptyState
        icon={<BoxIcon />}
        title="Stock list coming soon"
        description="The full product catalogue with stock levels, cover, and value will live here."
      />
    </div>
  );
}
