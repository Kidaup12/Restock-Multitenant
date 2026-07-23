import { Suspense } from "react";
import type { Metadata } from "next";
import { SkeletonCard } from "@/components/ui/skeleton";
import { RestockSuggestions } from "./restock-suggestions";
import { TodayDashboard } from "./today-dashboard";

export const metadata: Metadata = {
  title: "Today",
};

export default function TodayPage() {
  return (
    <div className="space-y-6">
      <TodayDashboard />
      {/* Streams in behind the fallback once the (placeholder) forecast resolves. */}
      <Suspense fallback={<SkeletonCard lines={3} />}>
        <RestockSuggestions />
      </Suspense>
    </div>
  );
}
