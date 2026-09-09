"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

/**
 * Re-read the shelf without reloading the page.
 *
 * Stock is the one screen people sit on while something else changes it — a
 * sync lands every fifteen minutes, a delivery gets booked in at the counter,
 * a transfer moves units between branches. Until now the only way to see any of
 * that was a browser reload, which throws away the sort, the search and the
 * column set the reader had chosen.
 *
 * It re-reads what we hold; it does not go and ask Shopify. That distinction is
 * deliberate and it is why the label is "Refresh" rather than anything
 * promising live figures: a store pull is rate-limited, takes minutes, and
 * already has its own control in Settings. The sidebar says when the last sync
 * landed, so the two together answer "is this current?" honestly.
 */
export function RefreshButton() {
  const router = useRouter();
  const [refreshing, startRefreshing] = useTransition();

  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => startRefreshing(() => router.refresh())}
      loading={refreshing}
      title="Re-read the latest synced figures, keeping your sort and filters"
    >
      Refresh
    </Button>
  );
}
