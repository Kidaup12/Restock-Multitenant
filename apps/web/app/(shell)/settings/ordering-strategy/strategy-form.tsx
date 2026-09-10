"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AbcWindowDays, OrderMethod } from "@wezesha/forecast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import {
  RECOMMENDED_WINDOW_DAYS,
  STRATEGY_GROUPS,
  STRATEGY_OPTIONS,
  WINDOW_OPTIONS,
  recommendedFor,
  strategyChanged,
  type StrategyClass,
} from "@/lib/ordering/strategy";
import { saveOrderingStrategy } from "./actions";

/**
 * Choosing how hard the buy list works to keep each group in stock.
 *
 * Cards rather than a dropdown. A select makes three options look
 * interchangeable and hides what separates them; the decision an owner is
 * actually making is a trade — more cash on the shelf against fewer lost sales
 * — and that is only visible when the trade is on screen for each choice.
 *
 * The engine's default is marked Recommended rather than pre-applied silently,
 * so a deliberate choice is distinguishable from one nobody has revisited.
 *
 * The window comes first because it decides WHICH products each style then
 * applies to. Choosing carefully how to buy your best sellers is worth nothing
 * if the wrong lines are counted as best sellers.
 */
export function StrategyForm({
  initial,
  initialWindowDays,
  canManage,
}: {
  initial: Record<StrategyClass, OrderMethod>;
  initialWindowDays: AbcWindowDays;
  canManage: boolean;
}) {
  const router = useRouter();
  const [values, setValues] = useState(initial);
  const [windowDays, setWindowDays] = useState<AbcWindowDays>(initialWindowDays);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();

  const dirty = strategyChanged(
    { methods: initial, windowDays: initialWindowDays },
    { methods: values, windowDays },
  );

  function submit() {
    setError(null);
    setSaved(false);
    start(async () => {
      const res = await saveOrderingStrategy({
        methodA: values.A,
        methodB: values.B,
        methodC: values.C,
        abcWindowDays: windowDays,
      });
      if (res.ok) {
        setSaved(true);
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Which products count as your best sellers"
          subtitle="We look at what each product earned over this period to sort them into the three groups below."
        />
        <CardContent className="grid gap-3 pt-4 md:grid-cols-3">
          {WINDOW_OPTIONS.map((option) => {
            const active = windowDays === option.days;
            return (
              <button
                key={option.days}
                type="button"
                aria-pressed={active}
                disabled={!canManage || pending}
                onClick={() => setWindowDays(option.days)}
                className={cn(
                  "rounded-lg border p-3 text-left transition-colors disabled:opacity-60",
                  active
                    ? "border-accent bg-accent-soft"
                    : "border-edge bg-surface hover:bg-surface-2",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-ink">{option.label}</span>
                  {option.days === RECOMMENDED_WINDOW_DAYS && (
                    <Badge tone="neutral">Recommended</Badge>
                  )}
                </div>
                <p className="mt-1 text-xs text-ink-muted">{option.hint}</p>
              </button>
            );
          })}
        </CardContent>
      </Card>

      {STRATEGY_GROUPS.map((group) => {
        const recommended = recommendedFor(group.key);
        return (
          <Card key={group.key}>
            <CardHeader
              title={group.label}
              subtitle={`${group.scope} · ${group.hint}`}
            />
            <CardContent className="grid gap-3 pt-4 md:grid-cols-3">
              {STRATEGY_OPTIONS.map((option) => {
                const active = values[group.key] === option.method;
                return (
                  <button
                    key={option.method}
                    type="button"
                    aria-pressed={active}
                    disabled={!canManage || pending}
                    onClick={() =>
                      setValues((v) => ({ ...v, [group.key]: option.method }))
                    }
                    className={cn(
                      "rounded-lg border p-3 text-left transition-colors disabled:opacity-60",
                      active
                        ? "border-accent bg-accent-soft"
                        : "border-edge bg-surface hover:bg-surface-2",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-ink">{option.label}</span>
                      {option.method === recommended && (
                        <Badge tone="neutral">Recommended</Badge>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-ink-muted">{option.summary}</p>
                    {/* The trade, in three fixed slots so the columns compare
                        down the page as well as across it. */}
                    <dl className="mt-2 space-y-0.5 text-2xs text-ink-muted">
                      <div>{option.inStock}</div>
                      <div>{option.cash}</div>
                      <div>{option.risk}</div>
                    </dl>
                    <p className="mt-2 text-2xs text-ink-faint">
                      <span className="font-medium">Best for:</span> {option.bestFor}
                    </p>
                  </button>
                );
              })}
            </CardContent>
          </Card>
        );
      })}

      {error && (
        <p role="alert" className="rounded-md bg-negative-soft px-3 py-2 text-sm text-negative">
          {error}
        </p>
      )}

      {canManage && (
        <div className="flex items-center gap-3">
          <Button onClick={submit} loading={pending} disabled={!dirty || pending}>
            Save changes
          </Button>
          {saved && !pending && (
            <span role="status" className="text-sm text-positive">
              Saved. Applies on the next forecast run.
            </span>
          )}
        </div>
      )}
    </div>
  );
}
