import type { Metadata } from "next";
import { GearIcon } from "@/components/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = {
  title: "Settings",
};

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Workspace, team, and integrations"
      />
      <EmptyState
        icon={<GearIcon />}
        title="Settings coming soon"
        description="Workspace preferences, users, and connected integrations will be managed here."
      />
    </div>
  );
}
