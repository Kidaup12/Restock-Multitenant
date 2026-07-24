"use client";

import { cn } from "@/lib/cn";
import { CostValue, formatNumber } from "@/components/ui/cost-value";
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
  onClick,
}: {
  label: string;
  value: React.ReactNode;
  sub: string;
  tone: "neutral" | "warning" | "negative";
  onClick?: () => void;
}) {
  const ring =
    tone === "negative"
      ? "hover:border-negative"
      : tone === "warning"
        ? "hover:border-warning"
        : "hover:border-edge-strong";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        "flex-1 rounded-lg border border-edge bg-surface p-4 text-left shadow-card transition-colors",
        onClick && ring,
        !onClick && "cursor-default",
      )}
    >
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
    </button>
  );
}

export function MoneyBand({
  band,
  canViewCosts,
  active,
  onSelect,
}: {
  band: MoneyBandData;
  canViewCosts: boolean;
  active: MoneyBandFilter;
  onSelect: (f: MoneyBandFilter) => void;
}) {
  const toggle = (f: Exclude<MoneyBandFilter, null>) => () => onSelect(active === f ? null : f);

  return (
    <div className="flex flex-wrap gap-3">
      <Tile
        label="Cash tied up in stock"
        value={<CostValue amount={band.cashTiedUpKes} canViewCosts={canViewCosts} compact />}
        sub="on-hand × cost, across the catalogue"
        tone="neutral"
      />
      <Tile
        label="Sitting dead / overstocked"
        value={<CostValue amount={band.deadOverstockKes} canViewCosts={canViewCosts} compact />}
        sub={`${formatNumber(band.deadOverstockCount)} products, cover past 90d`}
        tone="warning"
        onClick={toggle("dead_overstock")}
      />
      <Tile
        label="30-day revenue at risk"
        value={<CostValue amount={band.revenueAtRiskKes} canViewCosts={canViewCosts} compact />}
        sub={`${formatNumber(band.revenueAtRiskCount)} out or below lead time`}
        tone="warning"
        onClick={toggle("revenue_at_risk")}
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
        onClick={band.belowCostCount > 0 ? toggle("below_cost") : undefined}
      />
    </div>
  );
}
