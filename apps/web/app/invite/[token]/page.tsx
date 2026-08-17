import type { Metadata } from "next";
import Link from "next/link";
import { prismaService } from "@wezesha/db";
import { getSession } from "@/lib/auth";
import { getInvite, normalizeInviteEmail } from "@/lib/auth/invites";
import { Card, CardContent } from "@/components/ui/card";
import { AcceptInviteButton, SwitchAccountButton } from "./invite-controls";

export const metadata: Metadata = {
  title: "Invitation",
};

const roleLabels = { OWNER: "Owner", ADMIN: "Admin", MEMBER: "Member" } as const;

/** "an admin" / "an owner" / "a member" — the label decides, not a role check,
 *  so a new role reads correctly without another branch here. */
function article(label: string): string {
  return /^[AEIOU]/.test(label) ? "an" : "a";
}

function InviteCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="p-6 md:p-8">
        <h1 className="text-xl font-bold text-ink-strong">
          {title}
        </h1>
        {children}
      </CardContent>
    </Card>
  );
}

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const lookup = await getInvite(token);

  if (lookup.status !== "valid") {
    return (
      <InviteCard title="Invite not available">
        <p className="mt-2 text-sm text-ink-muted">
          {lookup.status === "expired"
            ? "This invite has expired. Ask a workspace admin to send a new one."
            : "This invite link is invalid or has already been used. Ask a workspace admin to send a new one."}
        </p>
        <p className="mt-6 text-center text-sm text-ink-muted">
          <Link
            href="/login"
            className="font-medium text-accent-ink hover:underline"
          >
            Go to sign in
          </Link>
        </p>
      </InviteCard>
    );
  }

  const { invite, tenantName } = lookup;
  const roleLabel = roleLabels[invite.role];
  const session = await getSession();
  const acceptPath = `/invite/${encodeURIComponent(token)}`;

  if (!session) {
    return (
      <InviteCard title={`Join ${tenantName}`}>
        <p className="mt-2 text-sm text-ink-muted">
          You&apos;ve been invited to join <strong>{tenantName}</strong> on
          Wezesha Restock as {article(roleLabel)}{" "}
          {roleLabel.toLowerCase()}. This invite was sent to{" "}
          <strong>{invite.email}</strong>.
        </p>
        <div className="mt-6 space-y-3">
          <Link
            href={`/signup?redirect=${encodeURIComponent(acceptPath)}`}
            className="flex h-10 w-full items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-on-accent transition-colors hover:bg-accent-strong"
          >
            Create an account
          </Link>
          <Link
            href={`/login?redirect=${encodeURIComponent(acceptPath)}`}
            className="flex h-10 w-full items-center justify-center rounded-md border border-edge bg-surface px-4 text-sm font-medium text-ink-secondary transition-colors hover:bg-surface-2 hover:text-ink"
          >
            I already have an account
          </Link>
        </div>
        <p className="mt-4 text-center text-xs text-ink-muted">
          Sign up with {invite.email} to accept this invite.
        </p>
      </InviteCard>
    );
  }

  if (normalizeInviteEmail(session.user.email) !== invite.email) {
    return (
      <InviteCard title="Different account">
        <p className="mt-2 text-sm text-ink-muted">
          This invite was sent to <strong>{invite.email}</strong>, but
          you&apos;re signed in as <strong>{session.user.email}</strong>. Switch
          to the invited account to accept it.
        </p>
        <div className="mt-6">
          <SwitchAccountButton />
        </div>
      </InviteCard>
    );
  }

  // Pre-join check: the visitor has no membership in this tenant yet, so no
  // scoped client can be built for it. The compound key carries the tenant.
  const existing = await prismaService.membership.findUnique({
    where: {
      userId_tenantId: {
        userId: session.user.id,
        tenantId: invite.tenantId,
      },
    },
    select: { id: true },
  });

  return (
    <InviteCard
      title={existing ? "Already a member" : `Join ${tenantName}`}
    >
      <p className="mt-2 text-sm text-ink-muted">
        {existing ? (
          <>
            You&apos;re already a member of <strong>{tenantName}</strong>.
          </>
        ) : (
          <>
            You&apos;ve been invited to join <strong>{tenantName}</strong> as{" "}
            {article(roleLabel)} {roleLabel.toLowerCase()}.
          </>
        )}
      </p>
      <div className="mt-6">
        <AcceptInviteButton
          token={token}
          label={existing ? "Open workspace" : `Join ${tenantName}`}
        />
      </div>
    </InviteCard>
  );
}
