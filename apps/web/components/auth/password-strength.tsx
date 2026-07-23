"use client";

import { cn } from "@/lib/cn";

/*
 * Client-side guidance only — the server enforces the real minimum. One point
 * each for: 8+ characters, mixed case, a digit, a symbol. Anything under 8
 * characters is capped at one segment regardless of variety.
 */
export function passwordScore(password: string): number {
  let score = 0;
  if (password.length >= 8) score++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[^a-zA-Z0-9]/.test(password)) score++;
  return password.length >= 8 ? score : Math.min(score, 1);
}

const labels = ["", "Weak", "Fair", "Good", "Strong"];
const labelTones = [
  "text-ink-muted",
  "text-negative",
  "text-warning",
  "text-ink-secondary",
  "text-positive",
];
const fills = ["", "bg-negative", "bg-warning", "bg-accent", "bg-positive"];

export function PasswordStrength({ password }: { password: string }) {
  const score = passwordScore(password);
  const tooShort = password.length > 0 && password.length < 8;
  const label = tooShort ? "Too short" : labels[score];

  return (
    <div aria-live="polite">
      <div className="flex gap-1">
        {[1, 2, 3, 4].map((step) => (
          <span
            key={step}
            className={cn(
              "h-1 flex-1 rounded-full transition-colors",
              step <= score ? fills[score] : "bg-track",
            )}
          />
        ))}
      </div>
      <p className={cn("mt-1.5 text-xs", labelTones[score])}>
        {password
          ? label
          : "Use 8+ characters with a mix of cases, numbers, and symbols"}
      </p>
    </div>
  );
}
