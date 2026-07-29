"use client";

import Link from "next/link";
import { cn } from "@/lib/cn";
import { CostValue } from "@/components/ui/cost-value";
import { formatNumber } from "@/lib/money";
import type { MoneyBand as MoneyBandData } from "@/lib/cost";

/**
 * The money band (spec §2): four owner's-eye tiles above the health strip, read
 * across the sellable catalogue, each a shortcut into its filter. KES figures go
 * through CostValue so a money-blind member never sees them — the band only
 * renders for a cost-viewing member, but the redaction seam stays honest.
 */

export type MoneyBandFilter = "dead_overstock" | "revenue_at_risk" | "below_cost" | null;

function Tile({
  label,
  value,
  sub,
  tone,
  href,
  active,
}: {
  label: string;
  value: React.ReactNode;
  sub: string;
  tone: "neutral" | "warning" | "negative";
  /** Omitted on a tile with nothing to filter to — it stays a plain figure. */
  href?: string;
  active?: boolean;
}) {
  const ring =
    tone === "negative"
      ? "hover:border-negative"
      : tone === "warning"
        ? "hover:border-warning"
        : "hover:border-edge-strong";
  const body = (
    <>
      <div className="text-xs font-medium tracking-wider text-ink-muted uppercase">{label}</div>
      <div
        className={cn(
          "mt-2 font-mono text-2xl font-semibold tracking-tight",
          tone === "negative" ? "text-negative" : "text-ink-strong",
        )}
      >
        {value}
      </div>
      <div className="mt-1 text-xs text-ink-muted">{sub}</div>
    </>
  );
  const shell = "flex-1 rounded-lg border bg-surface p-4 text-left shadow-card transition-colors";

  if (!href) {
    return <div className={cn(shell, "border-edge")}>{body}</div>;
  }
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={active ? "true" : undefined}
      className={cn(shell, active ? "border-edge-strong" : "border-edge", ring)}
    >
      {body}
    </Link>
  );
}

export function MoneyBand({
  band,
  canViewCosts,
  active,
  tileHref,
}: {
  band: MoneyBandData;
  canViewCosts: boolean;
  active: MoneyBandFilter;
  /** Each tile is a shortcut into its filter, so it is a link — clicking the
   *  active one clears it. */
  tileHref: (f: MoneyBandFilter) => string;
}) {
  const toggle = (f: Exclude<MoneyBandFilter, null>) => tileHref(active === f ? null : f);

  return (
    <div className="flex flex-wrap gap-3">
      <Tile
        label="Cash tied up in stock"
        value={<CostValue amount={band.cashTiedUpKes} canViewCosts={canViewCosts} compact />}
        sub="on-hand × cost, across the catalogue"
        tone="neutral"
      />
      <Tile
        label="Cash in slow-moving stock"
        value={<CostValue amount={band.deadOverstockKes} canViewCosts={canViewCosts} compact />}
        sub={`${formatNumber(band.deadOverstockCount)} products, 90+ days of cover or no sales`}
        tone="warning"
        href={toggle("dead_overstock")}
        active={active === "dead_overstock"}
      />
      <Tile
        label="30-day revenue at risk"
        value={<CostValue amount={band.revenueAtRiskKes} canViewCosts={canViewCosts} compact />}
        sub={`${formatNumber(band.revenueAtRiskCount)} out or below lead time`}
        tone="warning"
        href={toggle("revenue_at_risk")}
        active={active === "revenue_at_risk"}
      />
      <Tile
        label="Selling below cost"
        value={band.belowCostCount > 0 ? formatNumber(band.belowCostCount) : "0"}
        sub={
          band.belowCostCount > 0
            ? "products with a negative margin"
            : "no margin losers — good"
        }
        tone={band.belowCostCount > 0 ? "negative" : "neutral"}
        href={band.belowCostCount > 0 ? toggle("below_cost") : undefined}
        active={active === "below_cost"}
      />
    </div>
  );
}
