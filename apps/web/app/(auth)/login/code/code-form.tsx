"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

/* Two steps: request a code by email, then verify it. Verifying signs the
   user in (and creates the account on first use). */
export function CodeForm() {
  const router = useRouter();
  const [step, setStep] = useState<"email" | "otp">("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendCode(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const { error: sendError } = await authClient.emailOtp.sendVerificationOtp({
      email,
      type: "sign-in",
    });
    setSubmitting(false);
    if (sendError) {
      setError(sendError.message ?? "Could not send the code. Please try again.");
      return;
    }
    setOtp("");
    setStep("otp");
  }

  async function verifyCode(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const { error: verifyError } = await authClient.signIn.emailOtp({
      email,
      otp,
    });
    if (verifyError) {
      setSubmitting(false);
      setError(verifyError.message ?? "That code didn't work. Please try again.");
      return;
    }
    router.push("/today");
  }

  return (
    <div>
      <Card>
        <CardContent className="p-6 md:p-8">
          <h1 className="text-xl font-bold text-ink-strong">
            Sign in with a code
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            {step === "email"
              ? "We'll email you a one-time sign-in code"
              : `Enter the code sent to ${email}`}
          </p>

          {step === "email" ? (
            <form onSubmit={sendCode} className="mt-6 space-y-4">
              {error && (
                <p
                  role="alert"
                  className="rounded-md bg-negative-soft px-3 py-2 text-sm text-negative"
                >
                  {error}
                </p>
              )}

              <Field label="Email" htmlFor="code-email">
                <Input
                  id="code-email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@company.com"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>

              <Button type="submit" loading={submitting} className="w-full">
                Email me a code
              </Button>
            </form>
          ) : (
            <form onSubmit={verifyCode} className="mt-6 space-y-4">
              {error && (
                <p
                  role="alert"
                  className="rounded-md bg-negative-soft px-3 py-2 text-sm text-negative"
                >
                  {error}
                </p>
              )}

              <Field label="Sign-in code" htmlFor="code-otp">
                <Input
                  id="code-otp"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  required
                  value={otp}
                  onChange={(e) => setOtp(e.target.value)}
                  className="text-center font-mono text-base tracking-[0.4em]"
                />
              </Field>

              <Button type="submit" loading={submitting} className="w-full">
                Verify and sign in
              </Button>

              <div className="flex items-center justify-between text-sm">
                <button
                  type="button"
                  onClick={() => {
                    setStep("email");
                    setError(null);
                  }}
                  className="font-medium text-ink-secondary hover:text-ink hover:underline"
                >
                  Use a different email
                </button>
                <button
                  type="button"
                  onClick={(e) => void sendCode(e)}
                  className="font-medium text-accent-ink hover:underline"
                >
                  Resend code
                </button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>

      <p className="mt-6 text-center text-sm text-ink-muted">
        <Link
          href="/login"
          className="font-medium text-accent-ink hover:underline"
        >
          Back to password sign-in
        </Link>
      </p>
    </div>
  );
}
