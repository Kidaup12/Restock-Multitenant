import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { listPlatformAdmins } from "@/lib/admin/admins";
import { AdminsCard } from "./admins-card";
import { ProvisionForm } from "./provision-form";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { relativeTime } from "@/lib/notifications/format";
import { requireAdmin } from "@/lib/admin/gate";
import {
  filterFleet,
  getFleet,
  isConnected,
  isStale,
  sortFleet,
  SYNC_RESOURCES,
  type FleetRow,
  type FleetSort,
} from "@/lib/admin/fleet";
import { TableSearch } from "@/components/ui/table-search";
import { enterWorkspace } from "./actions";
import { SyncButton } from "./sync-button";

export const metadata: Metadata = {
  title: "Fleet",
};

const SORTS: { key: FleetSort; label: string }[] = [
  { key: "staleness", label: "Staleness" },
  { key: "name", label: "Name" },
  { key: "created", label: "Created" },
];

function parseSort(raw: string | undefined): FleetSort {
  return raw === "name" || raw === "created" ? raw : "staleness";
}

/** One resource's last-sync cell: red past the 24h staleness line. */
function SyncCell({ row, at }: { row: FleetRow; at: Date | null }) {
  if (!isConnected(row.connection.state)) {
    return <span className="text-ink-faint">—</span>;
  }
  if (!at) return <span className="font-medium text-negative">never</span>;
  return (
    <span className={isStale(at) ? "font-medium text-negative" : undefined}>
      {relativeTime(at.toISOString())}
    </span>
  );
}

/**
 * Failures and abandoned runs — the half a cursor cannot report.
 *
 * Cursors advance only on success, so a store failing every fifteen minutes
 * showed a fresh timestamp and a green row until the 24-hour line finally
 * tripped. The error text matters as much as the count: "token revoked" and
 * "rate limited" need different people.
 */
function RunHealthCell({ row }: { row: FleetRow }) {
  if (!isConnected(row.connection.state)) return <span className="text-ink-faint">—</span>;
  if (row.recentFailures === 0 && row.strandedRuns === 0) {
    return <span className="text-ink-faint">ok</span>;
  }
  return (
    <div className="space-y-0.5">
      {row.recentFailures > 0 && (
        <div className="font-medium text-negative">
          {row.recentFailures} failed
          {row.lastError && (
            <span className="block max-w-56 truncate font-normal text-ink-muted" title={row.lastError}>
              {row.lastError}
            </span>
          )}
        </div>
      )}
      {row.strandedRuns > 0 && (
        // Not a data problem — a worker was killed mid-run, almost always by a
        // deploy. Worth showing so "still running" is never mistaken for alive.
        <div className="text-warning">{row.strandedRuns} abandoned</div>
      )}
    </div>
  );
}

const connectionBadge = {
  live: <Badge tone="positive">Connected</Badge>,
  // Still installed, but nothing is syncing until someone reconnects it —
  // "Connected" here reads as healthy and is the opposite of the truth.
  paused: <Badge tone="negative">Not syncing</Badge>,
  uninstalled: <Badge tone="warning">Uninstalled</Badge>,
  none: <Badge tone="neutral">None</Badge>,
} as const;

export default async function AdminFleetPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string; q?: string }>;
}) {
  const admin = await requireAdmin();
  const params = await searchParams;
  const sort = parseSort(params.sort);
  const search = (params.q ?? "").trim().slice(0, 120);
  const [all, admins] = await Promise.all([
    getFleet().then((f) => sortFleet(f, sort)),
    listPlatformAdmins(admin),
  ]);
  // Sort first, then narrow: the order an operator chose has to survive a
  // search, and the count beside the box counts what the search left.
  const rows = filterFleet(all, search);

  /** One place that builds a link, so the sort tabs and the search box never
   *  silently drop each other's state. */
  const hrefFor = (patch: { sort?: string; q?: string }) => {
    const next = new URLSearchParams();
    const nextSort = "sort" in patch ? patch.sort : sort === "staleness" ? undefined : sort;
    const nextQ = "q" in patch ? patch.q : search || undefined;
    if (nextSort) next.set("sort", nextSort);
    if (nextQ) next.set("q", nextQ);
    const qs = next.toString();
    return qs ? `/admin?${qs}` : "/admin";
  };

  /**
   * The sort control, rendered WITH the table it orders.
   *
   * It used to sit in the page header, top right, with the whole console-access
   * card between it and the first row — so in any normal viewport, pressing a
   * tab changed nothing you could see except the address bar. Reported, exactly,
   * as "I have clicked on them and all I see is just the URL change". The sort
   * itself was always correct.
   */
  const sortTabs = (
    <div className="flex items-center gap-1 rounded-md border border-edge bg-surface p-0.5 text-xs">
      <span className="px-1.5 text-ink-muted">Sort</span>
      {SORTS.map((s) => (
        <Link
          key={s.key}
          href={hrefFor({ sort: s.key === "staleness" ? undefined : s.key })}
          aria-current={s.key === sort ? "true" : undefined}
          className={
            s.key === sort
              ? "rounded bg-surface-2 px-2 py-1 font-medium text-ink"
              : "rounded px-2 py-1 text-ink-muted transition-colors hover:text-ink"
          }
        >
          {s.label}
        </Link>
      ))}
    </div>
  );

  return (
    <div className="space-y-6">
      <PageHeader title="Fleet" description="Every workspace's sync health at a glance" />

      <AdminsCard admins={admins} />


      <ProvisionForm />

      {all.length === 0 ? (
        <EmptyState
          title="No workspaces yet"
          description="Tenants appear here as soon as they exist in the database."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No workspace matches that"
          description={`Nothing in ${all.length} workspaces matches "${search}". Clear the search to see them all.`}
        />
      ) : (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-4">
            <span className="text-sm font-medium text-ink">Workspaces</span>
            {sortTabs}
          </div>
          <TableSearch
            action="/admin"
            value={search}
            hidden={sort === "staleness" ? [] : [{ name: "sort", value: sort }]}
            placeholder="Search by workspace, slug or store domain"
            matched={rows.length}
            total={all.length}
            clearHref={hrefFor({ q: undefined })}
            label="Search workspaces"
            unit="workspace"
          />
          <Table className="min-w-[960px]">
            <TableHeader>
              <TableHead>Workspace</TableHead>
              <TableHead>Created</TableHead>
              <TableHead numeric>Members</TableHead>
              <TableHead numeric>Products</TableHead>
              <TableHead>Connection</TableHead>
              {SYNC_RESOURCES.map((r) => (
                <TableHead key={r}>{r} sync</TableHead>
              ))}
              <TableHead>Runs</TableHead>
              <TableHead numeric>Open alerts</TableHead>
              <TableHead>Last forecast</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.tenantId}>
                  <TableCell>
                    {/* Detail link only reads; entering (the audited grant) stays on the button. */}
                    <Link
                      href={`/admin/tenant/${row.tenantId}`}
                      className="font-medium text-ink hover:underline"
                    >
                      {row.name}
                    </Link>
                    <div className="text-xs text-ink-muted">{row.slug}</div>
                  </TableCell>
                  <TableCell className="text-xs">
                    {row.createdAt.toISOString().slice(0, 10)}
                  </TableCell>
                  <TableCell numeric>{row.memberCount}</TableCell>
                  <TableCell numeric>{row.productCount}</TableCell>
                  <TableCell>{connectionBadge[row.connection.state]}</TableCell>
                  {/* Last ARRIVAL, not last run. The cursor is stamped every
                      15 minutes whether or not anything came back, so showing it
                      here put "2 minutes ago" in green beside a store that has
                      sent nothing for a month — and disagreed with the sort,
                      which ranks on arrival. */}
                  {SYNC_RESOURCES.map((r) => (
                    <TableCell key={r} className="text-xs">
                      <SyncCell row={row} at={row.lastData[r]} />
                    </TableCell>
                  ))}
                  <TableCell className="text-xs">
                    <RunHealthCell row={row} />
                  </TableCell>
                  <TableCell numeric>
                    {row.openNotifications > 0 ? (
                      <span className="font-medium text-warning">{row.openNotifications}</span>
                    ) : (
                      0
                    )}
                  </TableCell>
                  <TableCell className="text-xs">
                    {row.lastForecastRunAt ? (
                      relativeTime(row.lastForecastRunAt.toISOString())
                    ) : (
                      <span className="text-ink-faint">never</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-2">
                      {/* Offered while paused too: a manual run is the operator's
                          way to check whether a reconnect actually took. */}
                      {isConnected(row.connection.state) && <SyncButton tenantId={row.tenantId} />}
                      <form action={enterWorkspace}>
                        <input type="hidden" name="tenantId" value={row.tenantId} />
                        <Button size="sm" type="submit">
                          Enter
                        </Button>
                      </form>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
