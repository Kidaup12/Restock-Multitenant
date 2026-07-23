"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { acceptInviteAction } from "./actions";

/** Accepts the invite; on success the action redirects into the workspace. */
export function AcceptInviteButton({
  token,
  label,
}: {
  token: string;
  label: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onAccept() {
    setError(null);
    startTransition(async () => {
      const result = await acceptInviteAction(token);
      // Only reached when the action returned instead of redirecting.
      setError(result.error);
    });
  }

  return (
    <div className="space-y-3">
      {error && (
        <p
          role="alert"
          className="rounded-md bg-negative-soft px-3 py-2 text-sm text-negative"
        >
          {error}
        </p>
      )}
      <Button loading={pending} onClick={onAccept} className="w-full">
        {label}
      </Button>
    </div>
  );
}

/** Sign out in place so the invited account can sign in instead. */
export function SwitchAccountButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function onSignOut() {
    setPending(true);
    await authClient.signOut();
    router.refresh();
  }

  return (
    <Button
      variant="ghost"
      loading={pending}
      onClick={() => void onSignOut()}
      className="w-full"
    >
      Sign out and use another account
    </Button>
  );
}
