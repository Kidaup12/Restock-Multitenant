"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/auth/password-input";
import { PasswordStrength } from "@/components/auth/password-strength";

export function SignupForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
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
    const { error: signUpError } = await authClient.signUp.email({
      email,
      password,
      // Display name defaults to the email's local part; editable on /profile.
      name: email.split("@")[0] ?? email,
    });
    if (signUpError) {
      setSubmitting(false);
      setError(signUpError.message ?? "Sign up failed. Please try again.");
      return;
    }
    router.push("/today");
  }

  return (
    <div>
      <Card>
        <CardContent className="p-6 md:p-8">
          <h1 className="font-display text-xl font-bold text-ink-strong">
            Create your account
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            Start restocking with confidence
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

            <Field label="Email" htmlFor="signup-email">
              <Input
                id="signup-email"
                type="email"
                autoComplete="email"
                placeholder="you@company.com"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>

            <Field label="Password" htmlFor="signup-password">
              <PasswordInput
                id="signup-password"
                autoComplete="new-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <PasswordStrength password={password} />
            </Field>

            <Field
              label="Confirm password"
              htmlFor="signup-confirm"
              error={confirmError}
            >
              <PasswordInput
                id="signup-confirm"
                autoComplete="new-password"
                required
                aria-invalid={confirmError ? true : undefined}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </Field>

            <Button type="submit" loading={submitting} className="w-full">
              Create account
            </Button>

            <p className="text-center text-xs text-ink-muted">
              By creating an account you agree to the Wezesha Terms &
              Conditions.
            </p>
          </form>
        </CardContent>
      </Card>

      <p className="mt-6 text-center text-sm text-ink-muted">
        Already have an account?{" "}
        <Link
          href="/login"
          className="font-medium text-accent-ink hover:underline"
        >
          Sign in
        </Link>
      </p>
    </div>
  );
}
