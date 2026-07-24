"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CostValue } from "@/components/ui/cost-value";
import { formatMovePct } from "@/lib/cost";
import type { CostMovedAlert } from "@/lib/data/costs";
import { dismissCostMovedAction } from "./actions";

/**
 * Cost-moved attention rows (spec §4): a synced cost that jumped more than ~20%.
 * Margins were recalculated — the owner checks the selling price, then dismisses
 * (which re-baselines the signal). FX swings never rewrite margins silently.
 */
export function CostMovedList({
  alerts,
  canManage,
}: {
  alerts: CostMovedAlert[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);

  if (alerts.length === 0) {
    return <p className="px-5 pb-5 text-sm text-ink-muted">No sharp cost moves. Margins are steady.</p>;
  }

  function dismiss(productId: string) {
    setBusy(productId);
    start(async () => {
      await dismissCostMovedAction({ productId });
      setBusy(null);
      router.refresh();
    });
  }

  return (
    <ul className="divide-y divide-edge">
      {alerts.map((a) => {
        const up = a.movedPct > 0;
        const since = a.movedAt.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
        return (
          <li key={a.productId} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium text-ink">{a.title}</span>
                <Badge tone={up ? "warning" : "positive"}>{formatMovePct(a.movedPct)}</Badge>
              </div>
              <p className="text-xs text-ink-muted">
                Cost {up ? "rose" : "fell"} {formatMovePct(a.movedPct)} since {since} — margins recalculated, check your selling price.
                {a.costKes != null && (
                  <>
                    {" "}
                    Now <CostValue amount={a.costKes} canViewCosts className="text-ink" /> vs price KES {Math.round(a.priceKes).toLocaleString("en-KE")}.
                  </>
                )}
              </p>
            </div>
            {canManage && (
              <Button size="sm" variant="ghost" loading={pending && busy === a.productId} onClick={() => dismiss(a.productId)}>
                Dismiss
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
