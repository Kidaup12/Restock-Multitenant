import type { Metadata } from "next";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { getLocationRoles } from "@/lib/locations/data";
import { getTillMappings } from "@/lib/data/pos-queues";
import { LayersIcon } from "@/components/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { LocationsView, TillsView } from "./locations-view";

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
  const [data, tills] = await Promise.all([
    getLocationRoles(membership.tenantId, { canViewCosts }),
    getTillMappings(membership.tenantId),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Locations" }]}
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
      {/* Tills need mapping even in a one-location shop — unmapped sales still
          miss that branch's run rate — so this sits outside the roles branch. */}
      {tills.length > 0 && (
        <TillsView
          tills={tills}
          locations={data.rows.map((row) => ({ id: row.id, name: row.name }))}
          canManage={canManage}
        />
      )}
    </div>
  );
}
