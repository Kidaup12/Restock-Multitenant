import { Suspense } from "react";
import type { Metadata } from "next";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { CalendarIcon } from "@/components/icons";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { SkeletonCard, SkeletonTableRows } from "@/components/ui/skeleton";
import { SignalsSection } from "./signals-section";

export const metadata: Metadata = {
  title: "Promotions & closures",
};

export default async function SignalsSettingsPage() {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);

  if (!membership) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Promotions & closures"
          description="Days that weren't normal trading"
        />
        <EmptyState
          icon={<CalendarIcon />}
          title="No workspace"
          description="You're not a member of any workspace yet. Ask an admin for an invite."
        />
      </div>
    );
  }

  const canManage = hasPermission(membership, "manage_settings");

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Promotions & closures" }]}
        title="Promotions & closures"
        description="Tell us when you were doing something out of the norm, so it doesn't skew what we tell you to buy"
      />
      <Suspense
        fallback={
          <div className="space-y-6">
            <SkeletonCard lines={4} />
            <div className="grid gap-6 lg:grid-cols-2">
              <SkeletonCard lines={6} />
              <SkeletonCard lines={6} />
            </div>
            <Card className="p-5">
              <SkeletonTableRows rows={4} />
            </Card>
          </div>
        }
      >
        <SignalsSection tenantId={membership.tenantId} canManage={canManage} />
      </Suspense>
    </div>
  );
}
