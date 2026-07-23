"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { CheckIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { PasswordInput } from "@/components/auth/password-input";
import { PasswordStrength } from "@/components/auth/password-strength";

export function ResetPasswordForm() {
  const params = useSearchParams();
  const token = params.get("token");
  const invalidLink = !token || params.get("error") === "INVALID_TOKEN";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setConfirmError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setConfirmError("Passwords don't match.");
      return;
    }
    setSubmitting(true);
    const { error: resetError } = await authClient.resetPassword({
      newPassword: password,
      token: token ?? "",
    });
    setSubmitting(false);
    if (resetError) {
      setError(resetError.message ?? "Could not reset the password. The link may have expired.");
      return;
    }
    setDone(true);
  }

  if (invalidLink) {
    return (
      <Card>
        <CardContent className="p-6 text-center md:p-8">
          <h1 className="font-display text-xl font-bold text-ink-strong">
            This link isn&apos;t valid
          </h1>
          <p className="mt-2 text-sm text-ink-muted">
            The reset link is missing or has expired. Request a fresh one and
            try again.
          </p>
          <p className="mt-6 text-sm">
            <Link
              href="/forgot-password"
              className="font-medium text-accent-ink hover:underline"
            >
              Request a new link
            </Link>
          </p>
        </CardContent>
      </Card>
    );
  }

  if (done) {
    return (
      <Card>
        <CardContent className="p-6 text-center md:p-8">
          <div className="mx-auto grid size-12 place-items-center rounded-md bg-positive-soft text-positive">
            <CheckIcon className="size-6" />
          </div>
          <h1 className="mt-4 font-display text-xl font-bold text-ink-strong">
            Password updated
          </h1>
          <p className="mt-2 text-sm text-ink-muted">
            Your new password is set. Sign in to continue.
          </p>
          <p className="mt-6 text-sm">
            <Link
              href="/login"
              className="font-medium text-accent-ink hover:underline"
            >
              Go to sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-6 md:p-8">
        <h1 className="font-display text-xl font-bold text-ink-strong">
          Choose a new password
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          Make it one you haven&apos;t used before
        </p>

        <form onSubmit={onSubmit} className="mt-6 space-y-4">
          {error && (
            <p
              role="alert"
              className="rounded-md bg-negative-soft px-3 py-2 text-sm text-negative"
            >
              {error}
            </p>
          )}

          <Field label="New password" htmlFor="reset-password">
            <PasswordInput
              id="reset-password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <PasswordStrength password={password} />
          </Field>

          <Field
            label="Confirm new password"
            htmlFor="reset-confirm"
            error={confirmError}
          >
            <PasswordInput
              id="reset-confirm"
              autoComplete="new-password"
              required
              aria-invalid={confirmError ? true : undefined}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </Field>

          <Button type="submit" loading={submitting} className="w-full">
            Reset password
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
