"use client";

import { useState, useTransition } from "react";
import type { Role } from "@wezesha/db";
import { cn } from "@/lib/cn";
import { TrashIcon, XIcon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  cancelTeamInvite,
  changeMemberRole,
  inviteTeammate,
  removeMember,
  type TeamActionResult,
} from "./actions";

export type MemberRow = {
  id: string;
  name: string;
  email: string;
  role: Role;
  joined: string;
  isSelf: boolean;
  /* Roles the viewer may move this member to (guards precomputed server-side). */
  roleOptions: Role[];
  canRemove: boolean;
};

export type InviteRow = {
  token: string;
  email: string;
  role: Role;
  expires: string;
};

const roleLabels: Record<Role, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  MEMBER: "Member",
};

export function TeamView({
  rows,
  invites,
  canManage,
  inviteRoles,
}: {
  rows: MemberRow[];
  invites: InviteRow[];
  canManage: boolean;
  inviteRoles: Role[];
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>(
    inviteRoles.includes("MEMBER") ? "MEMBER" : (inviteRoles[0] ?? "MEMBER"),
  );
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(action: () => Promise<TeamActionResult>) {
    setError(null);
    setSent(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.error);
    });
  }

  function onInvite(event: React.FormEvent) {
    event.preventDefault();
    const target = email.trim();
    setError(null);
    setSent(null);
    startTransition(async () => {
      const result = await inviteTeammate({ email: target, role });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEmail("");
      setSent(target);
    });
  }

  return (
    <div className="space-y-6">
      {canManage && inviteRoles.length > 0 && (
        <Card>
          <CardHeader
            title="Invite a teammate"
            subtitle="They'll get an email link, valid for 7 days"
          />
          <CardContent className="pt-4">
            <form
              onSubmit={onInvite}
              className="flex flex-col gap-3 sm:flex-row sm:items-end"
            >
              <Field label="Email" htmlFor="invite-email" className="flex-1">
                <Input
                  id="invite-email"
                  type="email"
                  autoComplete="off"
                  placeholder="teammate@company.com"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>
              <Field label="Role" htmlFor="invite-role">
                <Select
                  id="invite-role"
                  value={role}
                  onChange={(e) => setRole(e.target.value as Role)}
                  className="sm:w-32"
                >
                  {inviteRoles.map((option) => (
                    <option key={option} value={option}>
                      {roleLabels[option]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button type="submit" loading={pending}>
                Send invite
              </Button>
            </form>
            {sent && (
              <p className="mt-3 text-sm text-positive">Invite sent to {sent}.</p>
            )}
          </CardContent>
        </Card>
      )}

      {error && (
        <p
          role="alert"
          className="rounded-md bg-negative-soft px-3 py-2 text-sm text-negative"
        >
          {error}
        </p>
      )}

      <Card>
        <CardHeader
          title="Members"
          subtitle={`${rows.length} ${rows.length === 1 ? "person has" : "people have"} access`}
        />
        <CardContent className="p-0 pt-4">
          <Table>
            <TableHeader>
              <TableHead>Member</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Joined</TableHead>
              {/* Always here so the table has one shape; the remove button
                  inside it stays with the permission. */}
              <TableHead>{""}</TableHead>
            </TableHeader>
            <TableBody>
              {rows.map((member) => (
                <TableRow key={member.id}>
                  <TableCell className="font-medium text-ink">
                    <span className="inline-flex items-center gap-2">
                      {member.name}
                      {member.isSelf && <Badge tone="accent">You</Badge>}
                    </span>
                  </TableCell>
                  <TableCell>{member.email}</TableCell>
                  <TableCell>
                    {member.roleOptions.length > 0 ? (
                      <Select
                        aria-label={`Role for ${member.name}`}
                        value={member.role}
                        disabled={pending}
                        onChange={(e) =>
                          run(() =>
                            changeMemberRole({
                              membershipId: member.id,
                              role: e.target.value,
                            }),
                          )
                        }
                        size="sm"
                      >
                        <option value={member.role}>
                          {roleLabels[member.role]}
                        </option>
                        {member.roleOptions.map((option) => (
                          <option key={option} value={option}>
                            {roleLabels[option]}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <Badge tone={member.role === "OWNER" ? "accent" : "neutral"}>
                        {roleLabels[member.role]}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>{member.joined}</TableCell>
                  <TableCell numeric>
                    {canManage && member.canRemove && (
                      <button
                        type="button"
                        aria-label={`Remove ${member.name}`}
                        disabled={pending}
                        onClick={() => {
                          if (
                            window.confirm(
                              `Remove ${member.name} from this workspace?`,
                            )
                          ) {
                            run(() => removeMember({ membershipId: member.id }));
                          }
                        }}
                        className={cn(
                          "grid size-8 place-items-center rounded-md text-ink-muted transition-colors",
                          "outline-accent hover:bg-negative-soft hover:text-negative focus-visible:outline-2 focus-visible:outline-offset-2",
                          "disabled:pointer-events-none disabled:opacity-60",
                        )}
                      >
                        <TrashIcon className="size-4" />
                      </button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {canManage && invites.length > 0 && (
        <Card>
          <CardHeader
            title="Pending invites"
            subtitle="Waiting to be accepted"
          />
          <CardContent className="p-0 pt-4">
            <Table>
              <TableHeader>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>{""}</TableHead>
              </TableHeader>
              <TableBody>
                {invites.map((invite) => (
                  <TableRow key={invite.token}>
                    <TableCell className="font-medium text-ink">
                      {invite.email}
                    </TableCell>
                    <TableCell>
                      <Badge>{roleLabels[invite.role]}</Badge>
                    </TableCell>
                    <TableCell>{invite.expires}</TableCell>
                    <TableCell numeric>
                      <button
                        type="button"
                        aria-label={`Cancel invite for ${invite.email}`}
                        disabled={pending}
                        onClick={() =>
                          run(() => cancelTeamInvite({ token: invite.token }))
                        }
                        className={cn(
                          "grid size-8 place-items-center rounded-md text-ink-muted transition-colors",
                          "outline-accent hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2",
                          "disabled:pointer-events-none disabled:opacity-60",
                        )}
                      >
                        <XIcon className="size-4" />
                      </button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
