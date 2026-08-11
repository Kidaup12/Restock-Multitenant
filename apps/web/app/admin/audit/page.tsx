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
import { requireAdmin } from "@/lib/admin/gate";
import { listAuditActions, listAuditEvents } from "@/lib/admin/audit";
import { listTenants } from "@/lib/admin/fleet";
import { relativeTime } from "@/lib/notifications/format";

export const metadata: Metadata = {
  title: "Audit log",
};

/** Admin-surface actions get an accent so sessions stand out in the ledger. */
const ADMIN_ACTIONS = new Set(["impersonation_start", "impersonation_end", "admin_sync_trigger"]);

function metaSummary(meta: unknown): string {
  if (!meta || typeof meta !== "object") return "";
  return Object.entries(meta as Record<string, unknown>)
    .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" · ");
}

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ tenant?: string; action?: string; cursor?: string }>;
}) {
  await requireAdmin();
  const params = await searchParams;
  const tenantId = params.tenant || null;
  const action = params.action || null;

  const [page, tenants, actions] = await Promise.all([
    listAuditEvents({ tenantId, action, cursor: params.cursor || null }),
    listTenants(),
    listAuditActions(),
  ]);

  const filterQuery = (extra: Record<string, string>) => {
    const q = new URLSearchParams();
    if (tenantId) q.set("tenant", tenantId);
    if (action) q.set("action", action);
    for (const [k, v] of Object.entries(extra)) q.set(k, v);
    const s = q.toString();
    return s ? `?${s}` : "";
  };

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[{ label: "Workspaces", href: "/admin" }, { label: "Audit log" }]}
        title="Audit log"
        description="Every recorded action across all workspaces — admin sessions included"
      />

      <form
        method="get"
        className="flex flex-wrap items-end gap-3 rounded-lg border border-edge bg-surface p-4 shadow-card"
      >
        <label className="text-xs font-medium text-ink-muted">
          Workspace
          <select
            name="tenant"
            defaultValue={tenantId ?? ""}
            className="mt-1 block h-9 rounded-md border border-edge bg-surface px-2 text-sm text-ink"
          >
            <option value="">All workspaces</option>
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-ink-muted">
          Action
          <select
            name="action"
            defaultValue={action ?? ""}
            className="mt-1 block h-9 rounded-md border border-edge bg-surface px-2 text-sm text-ink"
          >
            <option value="">All actions</option>
            {actions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="ghost" size="sm">
          Filter
        </Button>
        {(tenantId || action) && (
          <Link href="/admin/audit" className="text-xs text-ink-muted hover:text-ink">
            Clear
          </Link>
        )}
      </form>

      {page.rows.length === 0 ? (
        <EmptyState
          title="No matching entries"
          description="Nothing in the ledger matches these filters yet."
        />
      ) : (
        <Card>
          <Table className="min-w-[860px]">
            <TableHeader>
              <TableHead>When</TableHead>
              <TableHead>Workspace</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Entity</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Detail</TableHead>
            </TableHeader>
            <TableBody>
              {page.rows.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="text-xs">
                    <span title={e.createdAt.toISOString()}>
                      {relativeTime(e.createdAt.toISOString())}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs">{e.tenantName ?? e.tenantId}</TableCell>
                  <TableCell>
                    <Badge tone={ADMIN_ACTIONS.has(e.action) ? "accent" : "neutral"}>
                      {e.action}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">{e.entity}</TableCell>
                  <TableCell className="text-xs">{e.actorName ?? "—"}</TableCell>
                  <TableCell className="max-w-[320px] truncate text-xs text-ink-muted">
                    {metaSummary(e.meta)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {page.nextCursor && (
        <div className="flex justify-center">
          <Link
            href={`/admin/audit${filterQuery({ cursor: page.nextCursor })}`}
            className="rounded-md border border-edge bg-surface px-4 py-2 text-sm text-ink-secondary transition-colors hover:bg-surface-2 hover:text-ink"
          >
            Older entries
          </Link>
        </div>
      )}
    </div>
  );
}
