"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { clearMonthExpectation, declareMonthExpectation } from "./actions";

/**
 * "December is about triple" — seasonality the shop states.
 *
 * Sits with promotions and closures because it is the same kind of thing: a
 * fact the owner holds that the sales history cannot show. Calendar guessing
 * (holidays, paydays) was tried in the engine and removed for hurting accuracy
 * without a full season of history to learn from; a shop saying so directly is
 * knowledge rather than a guess, and the forecast takes it the way it takes a
 * declared discount.
 */

export type DeclaredMonth = { month: string; multiplier: number };

/** The next twelve months, which is as far ahead as stating one is useful. */
function upcomingMonths(from: Date, count = 12): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

export function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  if (!y || !m) return key;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Plain words for a multiplier, so nobody has to read "1.8x" as a feeling. */
export function busynessLabel(multiplier: number): string {
  if (multiplier >= 1.995) return "about double a normal month or more";
  if (multiplier > 1.05) return `about ${Math.round((multiplier - 1) * 100)}% busier than normal`;
  if (multiplier < 0.95) return `about ${Math.round((1 - multiplier) * 100)}% quieter than normal`;
  return "about normal";
}

export function MonthExpectationCard({
  months,
  canManage,
  now = new Date(),
}: {
  months: DeclaredMonth[];
  canManage: boolean;
  now?: Date;
}) {
  const router = useRouter();
  const [month, setMonth] = useState(upcomingMonths(now)[0]!);
  const [multiplier, setMultiplier] = useState("1.5");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [pending, start] = useTransition();

  const stated = new Map(months.map((m) => [m.month, m.multiplier]));

  function run(action: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    setMessage(null);
    start(async () => {
      const result = await action();
      if (result.ok) {
        setMessage({ tone: "ok", text: result.message ?? "Saved." });
        setNote("");
        router.refresh();
      } else {
        setMessage({ tone: "err", text: result.error ?? "That didn't save." });
      }
    });
  }

  return (
    <Card>
      <CardHeader
        title="Months you know are different"
        subtitle="Tell us a month runs busier or quieter than normal, and we order for it"
      />
      <CardContent className="space-y-4">
        <p className="text-sm text-ink-secondary">
          We work out what you sell from your own sales history, so a season it has never seen is a
          season we cannot know about. If December runs at triple and January is dead, say so — the
          buy list sizes for it. Leave a month alone and nothing changes.
        </p>

        {canManage && (
          <div className="flex flex-wrap items-end gap-3">
            <label className="space-y-1">
              <span className="block text-xs font-medium tracking-wider text-ink-muted uppercase">
                Month
              </span>
              <Select
                value={month}
                onChange={(e) => setMonth(e.target.value)}
                aria-label="Month to size for"
                className="sm:w-44"
              >
                {upcomingMonths(now).map((key) => (
                  <option key={key} value={key}>
                    {monthLabel(key)}
                  </option>
                ))}
              </Select>
            </label>
            <label className="space-y-1">
              <span className="block text-xs font-medium tracking-wider text-ink-muted uppercase">
                How busy
              </span>
              <Input
                type="number"
                inputMode="decimal"
                min="0.25"
                max="4"
                step="0.25"
                value={multiplier}
                onChange={(e) => setMultiplier(e.target.value)}
                aria-label="How busy the month runs against a normal one"
                className="max-w-28"
              />
            </label>
            <label className="flex-1 space-y-1">
              <span className="block text-xs font-medium tracking-wider text-ink-muted uppercase">
                Note (optional)
              </span>
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Christmas trade"
                aria-label="Note about this month"
              />
            </label>
            <Button
              size="sm"
              loading={pending}
              onClick={() =>
                run(() =>
                  declareMonthExpectation({ month, multiplier: Number(multiplier), note })
                )
              }
            >
              Save month
            </Button>
          </div>
        )}

        {canManage && (
          <p className="text-xs text-ink-faint">
            1 is a normal month. 2 is twice as busy, 0.5 is half. For one big week rather than a
            whole month, declare a promotion instead — it carries its own dates.
          </p>
        )}

        {message && (
          <p className={`text-sm ${message.tone === "ok" ? "text-positive" : "text-negative"}`} role="status">
            {message.text}
          </p>
        )}

        {months.length === 0 ? (
          <p className="text-sm text-ink-muted">
            No months set. Every month is sized from your sales history alone.
          </p>
        ) : (
          <ul className="divide-y divide-edge rounded-md border border-edge">
            {months.map((m) => (
              <li key={m.month} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                <span className="text-sm">
                  <span className="font-medium text-ink">{monthLabel(m.month)}</span>{" "}
                  <span className="text-ink-muted">— {busynessLabel(m.multiplier)}</span>
                </span>
                {canManage && (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={pending}
                    onClick={() => run(() => clearMonthExpectation({ month: m.month }))}
                  >
                    Back to normal
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {stated.size > 0 && (
          <p className="text-xs text-ink-faint">
            Changes reach the buy list the next time the forecast runs.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
