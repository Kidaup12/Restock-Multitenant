import type { Metadata } from "next";
import { prismaForTenantTx, type Role } from "@wezesha/db";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { PageHeader } from "@/components/ui/page-header";
import { ProfileDetails } from "./profile-details";

export const metadata: Metadata = {
  title: "Profile",
};

const roleLabels: Record<Role, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  MEMBER: "Member",
};

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

export default async function ProfilePage() {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);

  // Money-blind basis: the value is only computed (and only reaches the
  // client) when the membership can see costs; MoneyGate masks the cell.
  let stockValueKes: number | null = null;
  if (membership && hasPermission(membership, "view_costs")) {
    const [row] = await prismaForTenantTx(membership.tenantId, (tx) =>
      tx.$queryRaw<[{ value: number }]>`
        SELECT COALESCE(SUM("costKes" * "currentStock"), 0)::float8 AS value
        FROM "Product"
        WHERE "active" AND NOT "notForSale"
      `,
    );
    stockValueKes = row?.value ?? 0;
  }

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Account"
        title="Profile"
        description="Your account and workspace access"
      />
      <ProfileDetails
        name={session.user.name}
        email={session.user.email}
        memberSince={dateFormat.format(session.user.createdAt)}
        workspace={
          membership
            ? {
                name: membership.tenant.name,
                roleLabel: roleLabels[membership.role],
                role: membership.role,
                permissions: membership.permissions,
              }
            : null
        }
        stockValueKes={stockValueKes}
      />
    </div>
  );
}
