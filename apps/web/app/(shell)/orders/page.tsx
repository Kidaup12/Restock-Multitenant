import type { Metadata } from "next";
import { ClipboardIcon } from "@/components/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = {
  title: "Orders",
};

export default function OrdersPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Orders"
        description="Purchase orders and deliveries"
      />
      <EmptyState
        icon={<ClipboardIcon />}
        title="No orders yet"
        description="Draft, sent, and received purchase orders will be tracked here."
      />
    </div>
  );
}
