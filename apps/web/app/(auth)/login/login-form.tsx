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

export function LoginForm({
  redirectTo,
}: {
  /* Post-login destination (sanitized server-side); e.g. an invite page. */
  redirectTo?: string | null;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const { error: signInError } = await authClient.signIn.email({
      email,
      password,
      rememberMe: remember,
    });
    if (signInError) {
      setSubmitting(false);
      setError(signInError.message ?? "Sign in failed. Please try again.");
      return;
    }
    router.push(redirectTo ?? "/today");
  }

  return (
    <div>
      <Card>
        <CardContent className="p-6 md:p-8">
          <h1 className="text-xl font-bold text-ink-strong">
            Welcome back
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            Sign in to your workspace
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

            <Field label="Email" htmlFor="login-email">
              <Input
                id="login-email"
                type="email"
                autoComplete="email"
                placeholder="you@company.com"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>

            <Field
              label="Password"
              htmlFor="login-password"
              hint={
                <Link
                  href="/forgot-password"
                  className="text-xs font-medium text-accent-ink hover:underline"
                >
                  Forgot password?
                </Link>
              }
            >
              <PasswordInput
                id="login-password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>

            <label className="flex items-center gap-2 text-sm text-ink-secondary">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="size-4 accent-accent"
              />
              Keep me signed in
            </label>

            <Button type="submit" loading={submitting} className="w-full">
              Sign in
            </Button>
          </form>

          <div className="mt-4 text-center">
            <Link
              href="/login/code"
              className="text-sm font-medium text-accent-ink hover:underline"
            >
              Sign in with a code instead
            </Link>
          </div>
        </CardContent>
      </Card>

      <p className="mt-6 text-center text-sm text-ink-muted">
        New to Wezesha?{" "}
        <Link
          href={
            redirectTo
              ? `/signup?redirect=${encodeURIComponent(redirectTo)}`
              : "/signup"
          }
          className="font-medium text-accent-ink hover:underline"
        >
          Create an account
        </Link>
      </p>
    </div>
  );
}
