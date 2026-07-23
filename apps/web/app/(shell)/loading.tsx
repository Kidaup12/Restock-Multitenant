import { Card, CardContent } from "@/components/ui/card";
import {
  Skeleton,
  SkeletonChart,
  SkeletonStatTile,
  SkeletonTableRows,
} from "@/components/ui/skeleton";

/* Route-level fallback: the page structure appears immediately on navigation. */
export default function Loading() {
  return (
    <div role="status" aria-label="Loading page" className="space-y-6">
      <div>
        <Skeleton className="h-7 w-40" />
        <Skeleton className="mt-2 h-4 w-64" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SkeletonStatTile />
        <SkeletonStatTile />
        <SkeletonStatTile />
        <SkeletonStatTile />
      </div>
      <Card>
        <CardContent>
          <SkeletonChart />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-0 py-2">
          <SkeletonTableRows rows={6} />
        </CardContent>
      </Card>
    </div>
  );
}
