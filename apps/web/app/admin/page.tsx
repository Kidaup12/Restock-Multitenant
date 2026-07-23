import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
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
  getFleet,
  isStale,
  sortFleet,
  SYNC_RESOURCES,
  type FleetRow,
  type FleetSort,
} from "@/lib/admin/fleet";
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
  if (row.connection.state !== "live") {
    return <span className="text-ink-faint">—</span>;
  }
  if (!at) return <span className="font-medium text-negative">never</span>;
  return (
    <span className={isStale(at) ? "font-medium text-negative" : undefined}>
      {relativeTime(at.toISOString())}
    </span>
  );
}

const connectionBadge = {
  live: <Badge tone="positive">Connected</Badge>,
  uninstalled: <Badge tone="warning">Uninstalled</Badge>,
  none: <Badge tone="neutral">None</Badge>,
} as const;

export default async function AdminFleetPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string }>;
}) {
  await requireAdmin();
  const sort = parseSort((await searchParams).sort);
  const rows = sortFleet(await getFleet(), sort);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Fleet"
        description="Every workspace's sync health at a glance"
        actions={
          <div className="flex items-center gap-1 rounded-md border border-edge bg-surface p-0.5 text-xs">
            {SORTS.map((s) => (
              <Link
                key={s.key}
                href={s.key === "staleness" ? "/admin" : `/admin?sort=${s.key}`}
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
        }
      />

      {rows.length === 0 ? (
        <EmptyState
          title="No workspaces yet"
          description="Tenants appear here as soon as they exist in the database."
        />
      ) : (
        <Card>
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
                  {SYNC_RESOURCES.map((r) => (
                    <TableCell key={r} className="text-xs">
                      <SyncCell row={row} at={row.lastSync[r]} />
                    </TableCell>
                  ))}
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
                      {row.connection.state === "live" && <SyncButton tenantId={row.tenantId} />}
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
