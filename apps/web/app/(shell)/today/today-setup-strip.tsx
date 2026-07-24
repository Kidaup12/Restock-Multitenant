import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BulbIcon, CheckIcon, ChevronRightIcon } from "@/components/icons";
import { setupDepth, type SetupSignal } from "@/lib/capabilities/setup-depth";

/**
 * Setup-health strip on Today — the roll-up of the four setup-depth signals.
 * It renders the capability spine's gate-1 reader on a real screen: the current
 * level, a pip per signal, and the one "turn this on to unlock X" nudge for the
 * next rung. Shrinks to an all-green confirmation at full depth. No page
 * restructure — this is one added card.
 */

const SIGNAL_ORDER: { key: SetupSignal; label: string }[] = [
  { key: "shopify", label: "Shopify" },
  { key: "costs", label: "Costs" },
  { key: "suppliers", label: "Suppliers" },
  { key: "posOrMultiLocation", label: "All channels" },
];

export async function TodaySetupStrip({ tenantId }: { tenantId: string }) {
  const { level, signals, nextUnlock } = await setupDepth(tenantId);

  return (
    <Card className="px-5 py-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-ink">Setup depth</span>
            <Badge tone={level >= 3 ? "positive" : "neutral"}>Level {level} of 3</Badge>
          </div>
          <ol className="flex items-center gap-3" aria-label="Setup signals">
            {SIGNAL_ORDER.map(({ key, label }) => {
              const on = signals[key];
              return (
                <li key={key} className="flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className={
                      on
                        ? "size-2.5 rounded-full bg-positive"
                        : "size-2.5 rounded-full border border-edge-strong bg-surface-2"
                    }
                  />
                  <span
                    className={on ? "text-xs text-ink-secondary" : "text-xs text-ink-muted"}
                  >
                    {label}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>

        {nextUnlock ? (
          <div className="flex items-start gap-2 text-sm sm:max-w-md sm:justify-end sm:text-right">
            <span className="mt-0.5 text-accent-ink [&_svg]:size-4">
              <BulbIcon />
            </span>
            <p className="text-ink-muted">
              <span className="font-medium text-ink">{nextUnlock.title}</span>{" "}
              {nextUnlock.detail}
            </p>
            <span className="mt-0.5 text-ink-muted [&_svg]:size-4">
              <ChevronRightIcon />
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-positive [&_svg]:size-4">
            <CheckIcon />
            <span>Full depth — every capability is unlocked.</span>
          </div>
        )}
      </div>
    </Card>
  );
}
