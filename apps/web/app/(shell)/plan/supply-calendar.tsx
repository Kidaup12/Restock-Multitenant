"use client";

import { useEffect, useState, useTransition } from "react";
import { CalendarIcon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CostValue } from "@/components/ui/cost-value";
import { SkeletonCard } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import type { CalendarBucket, SupplyCalendar } from "@/lib/data/plan-calendar";
import { loadSupplyCalendar } from "./calendar-actions";

/**
 * Mode 3 — the forward supply calendar. The buy list's order-by dates laid out
 * across the next few months, grouped by supplier, so the shop reads its
 * upcoming ordering commitments (when to order from whom, and the cash it
 * takes) at a glance, against what is already on order.
 *
 * The calendar is fetched on demand when this mode is picked (keeping the
 * initial Plan payload lean); the server action returns figures already
 * redacted for a money-blind caller.
 */

export function SupplyCalendarMode({
  canViewCosts,
  backLink,
}: {
  canViewCosts: boolean;
  backLink: React.ReactNode;
}) {
  const [calendar, setCalendar] = useState<SupplyCalendar | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    startTransition(async () => {
      const result = await loadSupplyCalendar();
      if (result.ok) setCalendar(result.data);
      else setError(result.error);
    });
  }, []);

  if (error) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-negative">{error}</p>
        <p className="text-sm text-ink-muted">{backLink}</p>
      </div>
    );
  }

  if (!calendar || pending) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-ink-muted">Building your ordering calendar… {backLink}</p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          <SkeletonCard lines={3} />
          <SkeletonCard lines={3} />
          <SkeletonCard lines={3} />
        </div>
      </div>
    );
  }

  return <SupplyCalendarView calendar={calendar} canViewCosts={canViewCosts} backLink={backLink} />;
}

function SupplyCalendarView({
  calendar,
  canViewCosts,
  backLink,
}: {
  calendar: SupplyCalendar;
  canViewCosts: boolean;
  backLink: React.ReactNode;
}) {
  const { buckets, openCommitments } = calendar;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-muted">
          {calendar.totalItemCount} orders to place over the next {calendar.horizonMonths} months ·{" "}
          <CostValue amount={calendar.totalCashKes} canViewCosts={canViewCosts} /> in all · {backLink}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {buckets.map((bucket) => (
          <BucketCard key={bucket.key} bucket={bucket} canViewCosts={canViewCosts} />
        ))}
      </div>

      {calendar.beyondHorizonItems > 0 && (
        <p className="text-sm text-ink-muted">
          {calendar.beyondHorizonItems} more{" "}
          {calendar.beyondHorizonItems === 1 ? "order lands" : "orders land"} beyond the{" "}
          {calendar.horizonMonths}-month window.
        </p>
      )}

      <Card>
        <CardHeader
          title="Already on order"
          subtitle="Cash committed on open purchase orders — what the calendar above is ordering on top of."
        />
        {openCommitments.length === 0 ? (
          <CardContent className="pt-3">
            <p className="text-sm text-ink-muted">
              {calendar.openOrderLines > 0
                ? `Nothing on a purchase order yet — ${calendar.openOrderLines} line${calendar.openOrderLines === 1 ? "" : "s"} queued to buy.`
                : "Nothing is on order yet."}
            </p>
          </CardContent>
        ) : (
          <CardContent className="space-y-2 pt-3">
            {openCommitments.map((c) => (
              <div
                key={c.supplierName ?? " unassigned"}
                className="flex flex-wrap items-center gap-2 text-sm"
              >
                <span className="font-medium text-ink">{c.supplierName ?? "Unassigned"}</span>
                <Badge tone="neutral">
                  {c.poCount} {c.poCount === 1 ? "PO" : "POs"}
                </Badge>
                <span className="ml-auto font-mono text-ink-secondary">
                  <CostValue amount={c.committedKes} canViewCosts={canViewCosts} />
                </span>
              </div>
            ))}
            {calendar.openOrderLines > 0 && (
              <p className="pt-1 text-xs text-ink-muted">
                {calendar.openOrderLines} order line{calendar.openOrderLines === 1 ? "" : "s"}{" "}
                queued or on a live PO.
              </p>
            )}
          </CardContent>
        )}
      </Card>
    </div>
  );
}

function BucketCard({
  bucket,
  canViewCosts,
}: {
  bucket: CalendarBucket;
  canViewCosts: boolean;
}) {
  return (
    <Card className="flex flex-col">
      <CardHeader
        title={bucket.label}
        subtitle={
          bucket.itemCount === 0
            ? "Nothing to order"
            : `${bucket.itemCount} ${bucket.itemCount === 1 ? "order" : "orders"} to place`
        }
        action={
          bucket.itemCount > 0 ? (
            <span className="font-mono text-sm font-medium text-ink">
              <CostValue amount={bucket.cashKes} canViewCosts={canViewCosts} />
            </span>
          ) : undefined
        }
      />
      <div className="mt-3 flex-1">
        {bucket.suppliers.length === 0 ? (
          <div className="grid place-items-center px-5 pt-2 pb-6 text-ink-muted [&_svg]:size-5">
            <CalendarIcon />
          </div>
        ) : (
          <ul className="divide-y divide-edge border-t border-edge">
            {bucket.suppliers.map((s) => (
              <li
                key={s.supplierName ?? " unassigned"}
                className={cn(
                  "flex items-center gap-3 px-5 py-2.5 text-sm transition-colors",
                  "hover:bg-surface-2/60"
                )}
              >
                <span className="min-w-0 flex-1 truncate text-ink-secondary">
                  {s.supplierName ?? "Unassigned"}
                </span>
                <Badge tone="neutral">{s.itemCount}</Badge>
                <span className="w-24 text-right font-mono text-ink">
                  <CostValue amount={s.cashKes} canViewCosts={canViewCosts} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
