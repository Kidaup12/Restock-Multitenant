import { Skeleton, SkeletonCard } from "@/components/ui/skeleton";

/* Route-level fallback: header + the two mode cards. */
export default function Loading() {
  return (
    <div role="status" aria-label="Loading plan" className="space-y-6">
      <div>
        <Skeleton className="h-7 w-24" />
        <Skeleton className="mt-2 h-4 w-56" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <SkeletonCard lines={2} />
        <SkeletonCard lines={2} />
      </div>
    </div>
  );
}
