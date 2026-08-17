"use client";

import { useState } from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";
import { MailIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const { error: requestError } = await authClient.requestPasswordReset({
      email,
      redirectTo: "/reset-password",
    });
    setSubmitting(false);
    if (requestError) {
      setError(requestError.message ?? "Something went wrong. Please try again.");
      return;
    }
    setSent(true);
  }

  if (sent) {
    return (
      <Card>
        <CardContent className="p-6 text-center md:p-8">
          <div className="mx-auto grid size-12 place-items-center rounded-md bg-accent-soft text-accent-ink">
            <MailIcon className="size-6" />
          </div>
          <h1 className="mt-4 text-xl font-bold text-ink-strong">
            Check your inbox
          </h1>
          {/* Same response whether or not the account exists — no enumeration. */}
          <p className="mt-2 text-sm text-ink-muted">
            If an account exists for {email}, a password reset link is on its
            way. The link expires in an hour.
          </p>
          <p className="mt-6 text-sm">
            <Link
              href="/login"
              className="font-medium text-accent-ink hover:underline"
            >
              Back to sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div>
      <Card>
        <CardContent className="p-6 md:p-8">
          <h1 className="text-xl font-bold text-ink-strong">
            Forgot your password?
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            We&apos;ll email you a link to reset it
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

            <Field label="Email" htmlFor="forgot-email">
              <Input
                id="forgot-email"
                type="email"
                autoComplete="email"
                placeholder="you@company.com"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>

            <Button type="submit" loading={submitting} className="w-full">
              Send reset link
            </Button>
          </form>
        </CardContent>
      </Card>

      <p className="mt-6 text-center text-sm text-ink-muted">
        <Link
          href="/login"
          className="font-medium text-accent-ink hover:underline"
        >
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
