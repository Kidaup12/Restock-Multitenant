import type { Metadata } from "next";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { getLocationRoles } from "@/lib/locations/data";
import { LayersIcon } from "@/components/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { LocationsView } from "./locations-view";

export const metadata: Metadata = {
  title: "Locations",
};

export default async function LocationsSettingsPage() {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);

  if (!membership) {
    return (
      <div className="space-y-6">
        <PageHeader title="Locations" description="What each location does for your stock math" />
        <EmptyState
          icon={<LayersIcon />}
          title="No workspace"
          description="You're not a member of any workspace yet. Ask an admin for an invite."
        />
      </div>
    );
  }

  const canManage = hasPermission(membership, "manage_settings");
  const canViewCosts = hasPermission(membership, "view_costs");
  const data = await getLocationRoles(membership.tenantId, { canViewCosts });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Locations"
        description="Tell us what each location does — it drives cover, transfers, and the buy list"
      />
      {data.singleLocation ? (
        <EmptyState
          icon={<LayersIcon />}
          title="One location, nothing to map"
          description="Roles only matter when stock is split across shops and warehouses. Add another location in Shopify and it'll show up here."
        />
      ) : (
        <LocationsView
          rows={data.rows}
          canManage={canManage}
          canViewCosts={canViewCosts}
          assumedCount={data.assumedCount}
          ignoreStockValueKes={data.ignoreStockValueKes}
        />
      )}
    </div>
  );
}
