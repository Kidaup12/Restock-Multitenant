import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { prismaForTenant } from "@wezesha/db";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { StatTile } from "@/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getSession } from "@/lib/auth";
import { requireAdmin } from "@/lib/admin/gate";
import { resolveAdminWorkspace } from "@/lib/admin/impersonation";
import { getTenantDetail, isStale, SYNC_RESOURCES } from "@/lib/admin/fleet";
import { listAuditEvents } from "@/lib/admin/audit";
import { getTodayMetrics, getReorderNeeded } from "@/lib/data/today";
import { relativeTime } from "@/lib/notifications/format";
import { enterWorkspace, exitWorkspace } from "../../actions";
import { SyncButton } from "../../sync-button";

export const metadata: Metadata = {
  title: "Workspace",
};

const kes = new Intl.NumberFormat("en-KE", {
  style: "currency",
  currency: "KES",
  maximumFractionDigits: 0,
});

const urgencyTone: Record<string, "negative" | "warning" | "neutral"> = {
  critical: "negative",
  high: "warning",
};

/**
 * Read-only view into one customer's workspace. Renders tenant data only when
 * the request carries a live signed workspace grant for THIS tenant — entering
 * (which writes the impersonation_start audit row) is the only way to get one.
 * All tenant reads go through the existing lib/data modules on the RLS-scoped
 * client, so this page sees exactly what the tenant's own pages would.
 */
export default async function AdminTenantPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdmin();
  const { id } = await params;

  const detail = await getTenantDetail(id);
  if (!detail) notFound();

  const grant = await resolveAdminWorkspace(await getSession());
  if (!grant || grant.tenantId !== id) {
    return (
      <div className="space-y-6">
        <PageHeader title={detail.tenant.name} description={detail.tenant.slug} />
        <EmptyState
          title="Not inside this workspace"
          description="Entering is logged to the audit trail and expires after 30 minutes."
          action={
            <form action={enterWorkspace}>
              <input type="hidden" name="tenantId" value={id} />
              <Button type="submit">Enter workspace</Button>
            </form>
          }
        />
      </div>
    );
  }

  const db = prismaForTenant(id);
  const [metrics, reorder, connection, cursors, audit] = await Promise.all([
    getTodayMetrics(id, { canViewCosts: true }),
    getReorderNeeded(id, { canViewCosts: true, limit: 6 }),
    db.shopifyConnection.findFirst(),
    db.ingestCursor.findMany({ where: { source: "shopify" } }),
    listAuditEvents({ tenantId: id, limit: 12 }),
  ]);
  const cursorByResource = new Map(cursors.map((c) => [c.resource, c.cursor]));

  return (
    <div className="space-y-6">
      <PageHeader
        title={detail.tenant.name}
        description={`${detail.tenant.slug} · read-only workspace view`}
        actions={
          <form action={exitWorkspace}>
            <Button variant="ghost" type="submit">
              Exit workspace
            </Button>
          </form>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Revenue · 30d" value={kes.format(metrics.revenue30dKes)} />
        <StatTile label="Tracked products" value={String(metrics.trackedProducts)} />
        <StatTile label="Stocked out" value={String(metrics.stockedOutProducts)} />
        <StatTile
          label={`Dead stock · ${metrics.deadStock.windowDays}d`}
          value={String(metrics.deadStock.skus)}
          delta={{
            label: `${kes.format(metrics.deadStock.costKes ?? 0)} tied up`,
            tone: metrics.deadStock.skus > 0 ? "negative" : "neutral",
          }}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Connection"
            subtitle="Shopify store + per-resource sync cursors"
            action={
              connection && !connection.uninstalledAt ? (
                <SyncButton tenantId={id} />
              ) : undefined
            }
          />
          <CardContent>
            {connection ? (
              <div className="space-y-3 text-sm">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-ink-muted">Store</span>
                  <span className="flex items-center gap-2 font-medium text-ink">
                    {connection.shopDomain}
                    {connection.uninstalledAt ? (
                      <Badge tone="warning">Uninstalled</Badge>
                    ) : (
                      <Badge tone="positive">Live</Badge>
                    )}
                  </span>
                </div>
                <ul className="divide-y divide-edge rounded-md border border-edge">
                  {SYNC_RESOURCES.map((resource) => {
                    const at = cursorByResource.get(resource) ?? null;
                    return (
                      <li
                        key={resource}
                        className="flex items-center justify-between px-3 py-2"
                      >
                        <span className="capitalize text-ink-secondary">{resource}</span>
                        <span className={isStale(at) ? "font-medium text-negative" : "text-ink"}>
                          {at ? relativeTime(at.toISOString()) : "never"}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : (
              <p className="text-sm text-ink-muted">No Shopify store connected.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader title="Members" subtitle={`${detail.members.length} in this workspace`} />
          <Table className="min-w-0">
            <TableHeader>
              <TableHead>Member</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Joined</TableHead>
            </TableHeader>
            <TableBody>
              {detail.members.map((m) => (
                <TableRow key={m.membershipId}>
                  <TableCell>
                    <div className="font-medium text-ink">{m.displayName ?? m.userName}</div>
                    <div className="text-xs text-ink-muted">{m.email}</div>
                  </TableCell>
                  <TableCell>
                    <Badge tone={m.role === "MEMBER" ? "neutral" : "accent"}>{m.role}</Badge>
                  </TableCell>
                  <TableCell className="text-xs">
                    {m.createdAt.toISOString().slice(0, 10)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Reorder needed"
          subtitle={
            reorder
              ? `Latest forecast run ${relativeTime(reorder.runDate.toISOString())} · ${reorder.totalPredicted} products covered`
              : "No forecast run yet"
          }
        />
        {reorder && reorder.rows.length > 0 ? (
          <Table>
            <TableHeader>
              <TableHead>SKU</TableHead>
              <TableHead>Product</TableHead>
              <TableHead numeric>On hand</TableHead>
              <TableHead numeric>Days left</TableHead>
              <TableHead>Urgency</TableHead>
              <TableHead numeric>Suggested qty</TableHead>
            </TableHeader>
            <TableBody>
              {reorder.rows.map((row) => (
                <TableRow key={row.productId}>
                  <TableCell className="font-mono text-xs">{row.sku}</TableCell>
                  <TableCell>{row.title}</TableCell>
                  <TableCell numeric>{row.onHandUnits}</TableCell>
                  <TableCell numeric>{row.daysUntilStockout}</TableCell>
                  <TableCell>
                    <Badge tone={urgencyTone[row.urgency] ?? "neutral"}>{row.urgency}</Badge>
                  </TableCell>
                  <TableCell numeric>{row.recommendedQty}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <CardContent>
            <p className="text-sm text-ink-muted">Nothing to reorder right now.</p>
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Recent audit trail"
          subtitle="Latest ledger entries for this workspace, admin sessions included"
        />
        {audit.rows.length > 0 ? (
          <Table>
            <TableHeader>
              <TableHead>When</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Entity</TableHead>
              <TableHead>Actor</TableHead>
            </TableHeader>
            <TableBody>
              {audit.rows.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="text-xs">
                    {relativeTime(e.createdAt.toISOString())}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{e.action}</TableCell>
                  <TableCell className="text-xs">{e.entity}</TableCell>
                  <TableCell className="text-xs">{e.actorName ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <CardContent>
            <p className="text-sm text-ink-muted">No audit entries yet.</p>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
