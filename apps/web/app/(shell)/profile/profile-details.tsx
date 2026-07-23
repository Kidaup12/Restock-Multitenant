"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export function ProfileDetails({
  name,
  email,
  memberSince,
  workspace,
}: {
  name: string;
  email: string;
  memberSince: string;
  workspace: { name: string; roleLabel: string } | null;
}) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState(name);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSave(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = displayName.trim();
    if (!trimmed) {
      setError("Display name can't be empty.");
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    const { error: updateError } = await authClient.updateUser({
      name: trimmed,
    });
    setSaving(false);
    if (updateError) {
      setError(updateError.message ?? "Could not save. Please try again.");
      return;
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader
          title="Account"
          subtitle="How you appear across the workspace"
        />
        <CardContent className="pt-4">
          <form onSubmit={onSave} className="space-y-4">
            <Field label="Display name" htmlFor="profile-name" error={error}>
              <div className="flex gap-2">
                <Input
                  id="profile-name"
                  autoComplete="name"
                  required
                  value={displayName}
                  onChange={(e) => {
                    setDisplayName(e.target.value);
                    setSaved(false);
                  }}
                />
                <Button
                  type="submit"
                  loading={saving}
                  disabled={displayName.trim() === name}
                >
                  Save
                </Button>
              </div>
              {saved && <p className="text-xs text-positive">Saved.</p>}
            </Field>

            <dl className="space-y-3 border-t border-edge pt-4 text-sm">
              <div className="flex items-center justify-between gap-4">
                <dt className="text-ink-muted">Email</dt>
                <dd className="truncate font-medium text-ink">{email}</dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-ink-muted">Member since</dt>
                <dd className="font-medium text-ink">{memberSince}</dd>
              </div>
            </dl>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader
          title="Workspace"
          subtitle="Where this account has access"
        />
        <CardContent className="pt-4">
          {workspace ? (
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-ink">
                  {workspace.name}
                </div>
                <div className="text-xs text-ink-muted">Active workspace</div>
              </div>
              <Badge tone="accent">{workspace.roleLabel}</Badge>
            </div>
          ) : (
            <p className="text-sm text-ink-muted">
              This account isn&apos;t a member of any workspace yet. Ask an
              admin for an invite.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
