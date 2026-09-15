import { ABC_KEYS, abcLabel, type AbcKey } from "@/lib/data/abc-lens";
import { type RangeKey } from "@/lib/data/report-range";

/**
 * The A/B/C lens as a compact segmented control — the cleaner, ref-styled
 * successor to page.tsx's `ClassRail`.
 *
 * A row of links, not client state, for the same reason the range and view rails
 * are: a chosen class then travels in the URL, so the filtered view is shareable,
 * survives a reload and works with Back. A server component that only emits
 * anchors — nothing that has to be invoked crosses into a panel, which is the
 * closure-across-the-boundary fault the page comments warn about.
 *
 * The active segment is accent-filled and the rest are muted, matching the
 * inspiration's pill: `inline-flex rounded-lg border p-0.5`, active fill on the
 * accent token, inactive `text-ink-muted`. It reads as one control rather than a
 * scatter of pills, which is what the older rail looked like.
 *
 * Href-building mirrors `ClassRail` but keeps the `tab` param it drops — this
 * control lives on the Overview tab and must not throw a reader back to the
 * default one when they change class.
 */
export function ClassFilter({
  abc,
  tab,
  range,
}: {
  /** The class currently in force, from the URL. */
  abc: AbcKey;
  /** The Overview tab key to preserve — a class change must not switch tabs. */
  tab: string;
  /** The report period to preserve alongside the class. */
  range: RangeKey;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-ink-muted">Class</span>
      <div
        className="inline-flex flex-wrap items-center gap-0.5 rounded-lg border border-edge bg-surface p-0.5"
        role="group"
        aria-label="Filter by ABC class"
      >
        {ABC_KEYS.map((key) => {
          const current = key === abc;
          return (
            <a
              key={key}
              href={`/insights?tab=${tab}&range=${range}&class=${key}`}
              aria-current={current ? "true" : undefined}
              className={
                current
                  ? "rounded-md bg-accent px-3 py-1 text-xs font-medium text-on-accent"
                  : "rounded-md px-3 py-1 text-xs font-medium text-ink-muted hover:bg-surface-muted hover:text-ink"
              }
            >
              {abcLabel(key)}
            </a>
          );
        })}
      </div>
    </div>
  );
}
