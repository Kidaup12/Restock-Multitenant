"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ExportBar, type ExportColumn } from "@/lib/export/export-bar";
import { SPEED_BAND_LABEL, type SpeedBand } from "@/lib/suppliers/lead-time";
import type { AssignableProduct, SupplierOption, SupplierRow, UnassignedBrand } from "@/lib/data/suppliers";
import {
  deleteSupplierAction,
  adoptLearnedLeadAction,
  type SupplierActionResult,
} from "./actions";
import { BulkAssignBar } from "./bulk-assign-bar";
import { SupplierForm } from "./supplier-form";
import { SupplierImport } from "./supplier-import";

type SortKey = "name" | "group" | "leadTyped" | "learned" | "moq" | "products" | "onTime";

const SPEED_TONE: Record<SpeedBand, "positive" | "accent" | "neutral"> = {
  local: "positive",
  regional: "accent",
  import: "neutral",
};

const DELETE_WARNING =
  "Remove this supplier? Its products fall back to category timing, lose PO grouping, and are re-flagged as unassigned. Delivery history and its scorecard are kept.";

const exportColumns: ExportColumn<SupplierRow>[] = [
  { header: "Supplier", cell: (r) => r.name },
  { header: "Group", cell: (r) => r.group ?? "" },
  { header: "Speed band", cell: (r) => (r.speedBand ? SPEED_BAND_LABEL[r.speedBand] : "") },
  { header: "Lead typed (d)", cell: (r) => r.leadTimeTypedDays },
  { header: "Learned median (d)", cell: (r) => r.learnedLeadDays },
  { header: "Deliveries", cell: (r) => r.deliveriesTracked },
  { header: "On-time %", cell: (r) => r.onTimePct },
  { header: "Fill %", cell: (r) => r.fillRatePct },
  { header: "Short-ship %", cell: (r) => r.shortShipPct },
  { header: "MOQ", cell: (r) => r.moq },
  { header: "Currency", cell: (r) => r.currency },
  { header: "Products", cell: (r) => r.assignedProductCount },
  { header: "Drift", cell: (r) => (r.drift.drifting ? "yes" : "") },
];

function SortHead({
  label,
  columnKey,
  numeric,
  active,
  dir,
  onToggle,
}: {
  label: string;
  columnKey: SortKey;
  numeric: boolean;
  active: boolean;
  dir: "asc" | "desc";
  onToggle: (key: SortKey) => void;
}) {
  return (
    <TableHead numeric={numeric}>
      <button
        type="button"
        onClick={() => onToggle(columnKey)}
        className="inline-flex items-center gap-1 uppercase tracking-wider outline-accent hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        {label}
        {active && <span aria-hidden>{dir === "asc" ? "▲" : "▼"}</span>}
      </button>
    </TableHead>
  );
}

function sortValue(row: SupplierRow, key: SortKey): string | number | null {
  switch (key) {
    case "name":
      return row.name.toLowerCase();
    case "group":
      return row.group?.toLowerCase() ?? null;
    case "leadTyped":
      return row.leadTimeTypedDays;
    case "learned":
      return row.learnedLeadDays;
    case "moq":
      return row.moq;
    case "products":
      return row.assignedProductCount;
    case "onTime":
      return row.onTimePct;
  }
}

export function SuppliersView({
  rows,
  unassignedBrands,
  supplierOptions,
  assignableProducts,
  canManage,
}: {
  rows: SupplierRow[];
  unassignedBrands: UnassignedBrand[];
  supplierOptions: SupplierOption[];
  assignableProducts: AssignableProduct[];
  canManage: boolean;
}) {
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<SupplierRow | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? rows.filter((r) =>
          [r.name, r.group, r.country, r.currency]
            .filter(Boolean)
            .some((v) => v!.toLowerCase().includes(q)),
        )
      : rows;
    return [...filtered].sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      if (av == null && bv == null) return 0;
      if (av == null) return 1; // nulls always last
      if (bv == null) return -1;
      const c = typeof av === "string" ? av.localeCompare(bv as string) : (av as number) - (bv as number);
      return sortDir === "asc" ? c : -c;
    });
  }, [rows, query, sortKey, sortDir]);

  function handleResult(result: SupplierActionResult) {
    if (result.ok) {
      setError(null);
      setNotice(result.message ?? "Done.");
    } else {
      setNotice(null);
      setError(result.error);
    }
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function run(id: string, action: () => Promise<SupplierActionResult>) {
    setBusyId(id);
    startTransition(async () => {
      const result = await action();
      handleResult(result);
      setBusyId(null);
    });
  }

  function remove(row: SupplierRow) {
    if (!window.confirm(DELETE_WARNING)) return;
    run(row.id, () => deleteSupplierAction({ supplierId: row.id }));
  }

  const sortHead = (label: string, k: SortKey, numeric = false) => (
    <SortHead
      label={label}
      columnKey={k}
      numeric={numeric}
      active={sortKey === k}
      dir={sortDir}
      onToggle={toggleSort}
    />
  );

  return (
    <div className="space-y-6">
      {notice && (
        <p className="rounded-md bg-positive-soft px-3 py-2 text-sm text-positive">{notice}</p>
      )}
      {error && (
        <p role="alert" className="rounded-md bg-negative-soft px-3 py-2 text-sm text-negative">
          {error}
        </p>
      )}

      <BulkAssignBar
        brands={unassignedBrands}
        supplierOptions={supplierOptions}
        canManage={canManage}
        onResult={handleResult}
      />

      {importing && canManage && <SupplierImport onClose={() => setImporting(false)} />}

      {editing && canManage && (
        <SupplierForm
          assignableProducts={assignableProducts}
          supplier={editing === "new" ? null : editing}
          onResult={handleResult}
          onClose={() => setEditing(null)}
        />
      )}

      <Card>
        <CardHeader
          title="Suppliers"
          subtitle={`${rows.length} ${rows.length === 1 ? "supplier" : "suppliers"}`}
          action={
            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="search"
                value={query}
                placeholder="Search suppliers…"
                onChange={(e) => setQuery(e.target.value)}
                className="h-8 w-44 text-sm"
                aria-label="Search suppliers"
              />
              <ExportBar rows={visible} columns={exportColumns} filename="suppliers" />
              {canManage && !importing && (
                <Button size="sm" variant="ghost" onClick={() => setImporting(true)}>
                  Import CSV
                </Button>
              )}
              {canManage && editing !== "new" && (
                <Button size="sm" onClick={() => setEditing("new")}>
                  Add supplier
                </Button>
              )}
            </div>
          }
        />
        <CardContent className="p-0 py-2">
          {rows.length === 0 ? (
            <EmptyState
              title="No suppliers yet"
              description="Import your supplier list as a CSV, or add one by hand, then assign products by brand."
              action={
                canManage ? (
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    <Button size="sm" onClick={() => setEditing("new")}>
                      Add supplier
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setImporting(true)}>
                      Import CSV
                    </Button>
                  </div>
                ) : undefined
              }
            />
          ) : (
            <Table>
              <TableHeader>
                {/* Lead time sits directly after the name on purpose: it is the
                    figure that decides when to reorder, and the one thing a shop
                    is really choosing a supplier on. */}
                {sortHead("Supplier", "name")}
                {sortHead("Lead (typed)", "leadTyped", true)}
                {sortHead("Learned", "learned", true)}
                <TableHead>Speed</TableHead>
                {sortHead("Group", "group")}
                {sortHead("MOQ", "moq", true)}
                {sortHead("Products", "products", true)}
                <TableHead>Scorecard</TableHead>
                {canManage && <TableHead>Actions</TableHead>}
              </TableHeader>
              <TableBody>
                {visible.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium text-ink">
                      <span className="inline-flex flex-wrap items-center gap-2">
                        {row.name}
                        {row.drift.drifting && (
                          <span title={driftTitle(row)}>
                            <Badge tone="warning">
                              Drift {row.drift.direction === "later" ? "↑" : "↓"}
                              {row.drift.deltaDays != null && ` ${Math.abs(row.drift.deltaDays)}d`}
                            </Badge>
                          </span>
                        )}
                      </span>
                      {row.country && (
                        <span className="mt-0.5 block text-xs text-ink-muted">{row.country}</span>
                      )}
                    </TableCell>
                    <TableCell numeric>
                      {row.leadTimeTypedDays != null ? (
                        <span>
                          {row.leadTimeTypedDays}d
                          <span className="block text-xs font-normal text-ink-muted">
                            ± {row.leadTimeStdDays}d
                          </span>
                        </span>
                      ) : (
                        <span className="text-ink-faint">not set</span>
                      )}
                    </TableCell>
                    <TableCell numeric>
                      {row.learnedLeadDays != null ? (
                        <div className="space-y-1">
                          <div className={row.drift.drifting ? "text-warning" : undefined}>
                            {row.learnedLeadDays}d
                          </div>
                          <div className="text-xs font-normal text-ink-muted">
                            median · {row.deliveriesTracked}{" "}
                            {row.deliveriesTracked === 1 ? "delivery" : "deliveries"}
                          </div>
                          {canManage && row.learnedLeadDays !== row.leadTimeTypedDays && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 px-2 text-xs"
                              loading={pending && busyId === row.id}
                              onClick={() =>
                                run(row.id, () => adoptLearnedLeadAction({ supplierId: row.id }))
                              }
                            >
                              Use learned
                            </Button>
                          )}
                        </div>
                      ) : (
                        <span className="text-ink-faint">learning…</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {row.speedBand ? (
                        <Badge tone={SPEED_TONE[row.speedBand]}>
                          {SPEED_BAND_LABEL[row.speedBand]}
                        </Badge>
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {row.group ? (
                        <Badge tone="neutral">{row.group}</Badge>
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                    </TableCell>
                    <TableCell numeric>{row.moq}</TableCell>
                    <TableCell numeric>
                      {/* The count is the way in to changing it — a shop looking
                          at "12 products" is usually about to ask which. */}
                      <Link
                        href={`/suppliers/${row.id}/products`}
                        className="text-accent-ink underline-offset-2 hover:underline"
                      >
                        {row.assignedProductCount}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <ScoreBadges row={row} />
                    </TableCell>
                    {canManage && (
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => setEditing(row)}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            loading={pending && busyId === row.id}
                            onClick={() => remove(row)}
                          >
                            Remove
                          </Button>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function driftTitle(row: SupplierRow): string {
  const delta = row.drift.deltaDays != null ? Math.abs(row.drift.deltaDays) : null;
  const dir = row.drift.direction === "later" ? "later" : "earlier";
  if (delta == null) return "Learned lead time has drifted from the typed value.";
  return `Deliveries are running ${delta} day${delta === 1 ? "" : "s"} ${dir} than the ${row.leadTimeTypedDays}d you set.`;
}

function ScoreBadges({ row }: { row: SupplierRow }) {
  if (row.deliveriesTracked === 0) {
    return <span className="text-xs text-ink-faint">No deliveries yet</span>;
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {row.onTimePct != null && (
        <Badge tone={row.onTimePct >= 80 ? "positive" : row.onTimePct >= 50 ? "warning" : "negative"}>
          On-time {row.onTimePct}%
        </Badge>
      )}
      {row.fillRatePct != null && (
        <Badge tone={row.fillRatePct >= 95 ? "positive" : row.fillRatePct >= 80 ? "warning" : "negative"}>
          Fill {row.fillRatePct}%
        </Badge>
      )}
      {row.shortShipPct != null && row.shortShipPct > 0 && (
        <Badge tone={row.shortShipPct <= 5 ? "warning" : "negative"}>
          Short-ship {row.shortShipPct}%
        </Badge>
      )}
    </span>
  );
}
