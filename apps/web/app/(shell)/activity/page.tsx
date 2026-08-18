import type { Metadata } from "next";
import { Suspense } from "react";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Pager } from "@/components/ui/pager";
import { SkeletonCard } from "@/components/ui/skeleton";
import { TableSearch } from "@/components/ui/table-search";
import { countActivity, getActivity } from "@/lib/data/activity";
import {
  activityPageBounds,
  activityQueryToSearch,
  parseActivityQuery,
  withActivityQuery,
  type ActivityQuery,
  type RawSearchParams,
} from "./query";

export const metadata: Metadata = {
  title: "Activity log",
};

const when = (at: Date) =>
  at.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

async function ActivityList({
  tenantId,
  canViewCosts,
  currency,
  query,
}: {
  tenantId: string;
  canViewCosts: boolean;
  currency: string;
  query: ActivityQuery;
}) {
  // Count first: the reader's page has to be clamped against the real total
  // before the rows are fetched, or a bookmarked page 4 of a log that has since
  // been searched down comes back empty.
  const total = await countActivity(tenantId, { canViewCosts, search: query.search });
  const { pageCount, current, start } = activityPageBounds(total, query.page);
  const entries = await getActivity(tenantId, {
    canViewCosts,
    currency,
    search: query.search,
    page: current,
  });

  const hrefFor = (patch: Partial<ActivityQuery>) =>
    `/activity${activityQueryToSearch(withActivityQuery(query, patch))}`;

  return (
    <Card>
      {/* Nothing hidden to carry: `q` and `page` are the whole query, and
          dropping `page` on submit is the reset back to page 1. */}
      {(total > 0 || query.search) && (
        <TableSearch
          action="/activity"
          value={query.search}
          placeholder="Search by who did it, or what happened — cancelled, received, supplier"
          matched={query.search ? total : null}
          clearHref={hrefFor({ search: "" })}
          label="Search the activity log"
        />
      )}

      {entries.length === 0 ? (
        <EmptyState
          title={query.search ? "Nothing matches that" : "Nothing recorded yet"}
          description={
            query.search
              ? "Try a shorter search — the name of whoever did it, or a word like cancelled or received."
              : "Once orders are placed, received or cancelled — or a cost is changed — it shows up here."
          }
        />
      ) : (
        <ul>
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="flex flex-col gap-1 border-b border-edge px-5 py-3 last:border-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
            >
              <span className="text-sm text-ink">
                {entry.summary}
                {entry.actor && <span className="text-ink-muted"> · {entry.actor}</span>}
              </span>
              <span className="shrink-0 text-xs text-ink-muted">{when(entry.at)}</span>
            </li>
          ))}
        </ul>
      )}

      {pageCount > 1 && (
        <Pager
          page={current}
          pageCount={pageCount}
          from={start + 1}
          to={start + entries.length}
          total={total}
          pageHref={(next) => hrefFor({ page: next })}
          label="Activity pages"
        />
      )}
    </Card>
  );
}

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  const query = parseActivityQuery(await searchParams);

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Account"
        title="Activity log"
        description="Who created, ordered, cancelled or received orders, and who changed a cost. Kept for accounting — entries can't be edited or removed."
      />
      {membership && (
        <Suspense
          // Keyed on the query: the boundary has to remount for a new page or
          // search to render, and it shows the skeleton while the rows load.
          key={activityQueryToSearch(query)}
          fallback={<SkeletonCard />}
        >
          <ActivityList
            tenantId={membership.tenantId}
            canViewCosts={hasPermission(membership, "view_costs")}
            currency={membership.tenant.currency ?? "KES"}
            query={query}
          />
        </Suspense>
      )}
    </div>
  );
}
