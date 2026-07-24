import { cn } from "@/lib/cn";
import { SkeletonLoadingBeacon } from "@/components/shell/route-loading";

/*
 * Skeleton variants mirror the shape of the component they stand in for.
 * The shimmer itself is the .skeleton class in globals.css.
 */

export function Skeleton({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      aria-hidden="true"
      style={style}
      className={cn("skeleton rounded-sm", className)}
    />
  );
}

export function SkeletonCard({
  lines = 3,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  const widths = ["w-3/5", "w-4/5", "w-2/5", "w-3/4"];
  return (
    <div
      aria-hidden="true"
      className={cn(
        "rounded-lg border border-edge bg-surface p-5 shadow-card",
        className,
      )}
    >
      <SkeletonLoadingBeacon />
      <Skeleton className="h-4 w-1/3" />
      <div className="mt-4 space-y-2.5">
        {Array.from({ length: lines }, (_, i) => (
          <Skeleton key={i} className={cn("h-3", widths[i % widths.length])} />
        ))}
      </div>
    </div>
  );
}

export function SkeletonStatTile({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "relative rounded-lg border border-edge bg-surface p-5 shadow-card",
        className,
      )}
    >
      <SkeletonLoadingBeacon />
      <Skeleton className="absolute top-4 right-4 size-9 rounded-md" />
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-3 h-8 w-32" />
      <Skeleton className="mt-3 h-3 w-20" />
    </div>
  );
}

const rowWidths = [
  ["w-40", "w-12", "w-10", "w-20", "w-10", "w-16"],
  ["w-48", "w-10", "w-12", "w-16", "w-12", "w-14"],
  ["w-36", "w-12", "w-10", "w-24", "w-10", "w-16"],
  ["w-44", "w-14", "w-10", "w-20", "w-12", "w-14"],
];

export function SkeletonTableRows({
  rows = 5,
  className,
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div aria-hidden="true" className={cn("w-full", className)}>
      <SkeletonLoadingBeacon />
      {Array.from({ length: rows }, (_, i) => {
        const cols = rowWidths[i % rowWidths.length];
        return (
          <div
            key={i}
            className="flex items-center gap-6 border-b border-edge px-4 py-3.5 last:border-0"
          >
            <Skeleton className={cn("h-3.5", cols[0])} />
            <div className="ml-auto flex items-center gap-6">
              <Skeleton className={cn("hidden h-3.5 sm:block", cols[1])} />
              <Skeleton className={cn("hidden h-3.5 sm:block", cols[2])} />
              <Skeleton className={cn("h-5 rounded-full", cols[3])} />
              <Skeleton className={cn("h-3.5", cols[5])} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

const chartBars = [40, 62, 35, 70, 55, 82, 45, 66, 50, 76, 60, 90, 72, 96];

export function SkeletonChart({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn("w-full", className)}>
      <SkeletonLoadingBeacon />
      <div className="flex h-28 items-end gap-1.5 border-b border-edge pb-px">
        {chartBars.map((h, i) => (
          <Skeleton
            key={i}
            className="flex-1 rounded-t-sm rounded-b-none"
            // Static placeholder heights, tallest bar last.
            style={{ height: `${h}%` }}
          />
        ))}
      </div>
      <div className="mt-3 flex justify-between">
        <Skeleton className="h-3 w-12" />
        <Skeleton className="h-3 w-12" />
      </div>
    </div>
  );
}
