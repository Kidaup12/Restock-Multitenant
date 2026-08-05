import Link from "next/link";
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

/* The screen each nudge sends you to. A POS feed or a second branch has no
 * single screen to open, so that nudge stays plain text. */
const NUDGE_HREF: Partial<Record<SetupSignal, string>> = {
  shopify: "/settings/connections",
  costs: "/costs",
  suppliers: "/suppliers",
  // Until the till screen existed this rung had nowhere to send anyone, so it
  // rendered as advice you couldn't act on.
  posOrMultiLocation: "/settings/pos",
};

const SIGNAL_ORDER: { key: SetupSignal; label: string }[] = [
  { key: "shopify", label: "Shopify" },
  { key: "costs", label: "Costs" },
  { key: "suppliers", label: "Suppliers" },
  { key: "posOrMultiLocation", label: "All channels" },
];

export async function TodaySetupStrip({ tenantId }: { tenantId: string }) {
  const { level, signals, nextUnlock } = await setupDepth(tenantId);
  const done = SIGNAL_ORDER.filter(({ key }) => signals[key]).length;
  const nudgeHref = nextUnlock ? NUDGE_HREF[nextUnlock.signal] : undefined;
  const nudge = nextUnlock ? (
    <>
      <span className="mt-0.5 text-accent-ink [&_svg]:size-4">
        <BulbIcon />
      </span>
      <p className="text-ink-muted">
        <span className="font-medium text-ink">{nextUnlock.title}</span>{" "}
        {nextUnlock.detail}
      </p>
    </>
  ) : null;

  return (
    <Card className="px-5 py-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        {/* Wraps at every level. On a 390px phone the label, the level badge,
            the counter and four signals in one non-wrapping row pushed the
            document to 485px wide, so first-run Today scrolled sideways and
            felt broken. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-ink">Setup depth</span>
            <Badge tone={level >= 3 ? "positive" : "neutral"}>Level {level} of 3</Badge>
            {/* The level is a capability rung; this is the plainer question the
                owner is actually asking — how much is left. */}
            <span className="text-xs text-ink-muted">
              {done} of {SIGNAL_ORDER.length} done
            </span>
          </div>
          <ol className="flex flex-wrap items-center gap-x-3 gap-y-1" aria-label="Setup signals">
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
          nudgeHref ? (
            <Link
              href={nudgeHref}
              className="-mx-2 -my-1 flex items-start gap-2 rounded-md px-2 py-1 text-sm outline-accent transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 sm:max-w-md sm:justify-end sm:text-right"
            >
              {nudge}
              <span className="mt-0.5 text-ink-muted [&_svg]:size-4">
                <ChevronRightIcon />
              </span>
            </Link>
          ) : (
            <div className="flex items-start gap-2 text-sm sm:max-w-md sm:justify-end sm:text-right">
              {nudge}
            </div>
          )
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
