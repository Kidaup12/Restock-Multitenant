import type { Metadata } from "next";
import type { Role } from "@wezesha/db";
import { activeMembership, requireSession } from "@/lib/auth";
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

  return (
    <div className="space-y-6">
      <PageHeader
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
              }
            : null
        }
      />
    </div>
  );
}
