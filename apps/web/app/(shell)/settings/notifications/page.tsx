import type { Metadata } from "next";
import { prismaForTenant } from "@wezesha/db";
import { parseNotifyPrefs } from "@wezesha/db/notify-prefs";
import { activeMembership, requireSession } from "@/lib/auth";
import { PageHeader } from "@/components/ui/page-header";
import { NotificationsForm } from "./notifications-form";

/**
 * A member's own email switches, for the workspace they are in. Separate from
 * Workspace settings on purpose: everything there belongs to the shop and needs
 * `manage_settings`, while this belongs to the person and needs nothing beyond
 * being a member.
 */

export const metadata: Metadata = {
  title: "Your emails",
};

export default async function NotificationsSettingsPage() {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) return null;

  const db = prismaForTenant(membership.tenantId);
  const [mine, config] = await Promise.all([
    db.membership.findFirst({
      where: { id: membership.id },
      select: { notifyPrefs: true },
    }),
    db.tenantConfig.findFirst({ select: { alertEmail: true } }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Your emails" }]}
        title="Your emails"
        description="Which messages this workspace sends to you. Only yours — teammates choose their own."
      />
      <NotificationsForm
        initial={parseNotifyPrefs(mine?.notifyPrefs)}
        centralisedTo={config?.alertEmail ?? null}
      />
    </div>
  );
}
