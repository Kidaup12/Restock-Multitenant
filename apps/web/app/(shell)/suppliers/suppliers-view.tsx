"use client";

import { useState, useTransition } from "react";
import { useConfirm } from "@/components/ui/confirm-dialog";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Pager } from "@/components/ui/pager";
import { TableSearch } from "@/components/ui/table-search";
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
import type {
  AssignableProduct,
  SupplierOption,
  SupplierQuery,
  SupplierRow,
  SupplierSortKey,
  UnassignedBrand,
} from "@/lib/data/suppliers";
import {
  deleteSupplierAction,
  adoptLearnedLeadAction,
  type SupplierActionResult,
} from "./actions";
import { BulkAssignBar } from "./bulk-assign-bar";
import { SupplierForm } from "./supplier-form";
import { SupplierImport } from "./supplier-import";

/**
 * The list's state is the address bar: the server searches, sorts and pages,
 * and every control here is a link that asks it again. That keeps a filtered
 * list linkable, survives the revalidate after an edit, and stops the table
 * from sorting one page of rows while claiming to have ordered the whole list.
 *
 * The URL vocabulary is read back by `parseSupplierQuery` in lib/data/suppliers;
 * the round-trip is held by a test, because the two halves live apart — a data
 * module cannot be imported for its values by a client component without
 * dragging the database client into the browser bundle.
 */
export function supplierQueryToSearch(q: SupplierQuery): string {
  const params = new URLSearchParams();
  if (q.search) params.set("q", q.search);
  if (q.sortKey !== "name") params.set("sort", q.sortKey);
  if (q.desc) params.set("dir", "desc");
  if (q.page > 0) params.set("page", String(q.page));
  const search = params.toString();
  return search ? `?${search}` : "";
}

/** Every control except the pager changes WHICH suppliers match, so every one
 *  of them sends the reader back to the first page. */
export function withSupplierQuery(q: SupplierQuery, patch: Partial<SupplierQuery>): SupplierQuery {
  const next = { ...q, ...patch };
  return patch.page === undefined ? { ...next, page: 0 } : next;
}

const SPEED_TONE: Record<SpeedBand, "positive" | "accent" | "neutral"> = {
  local: "positive",
  regional: "accent",
  import: "neutral",
};

const DELETE_WARNING =
  "Its products fall back to category timing, lose PO grouping, and are re-flagged as unassigned. Delivery history and its scorecard are kept.";

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
  query,
  hrefFor,
}: {
  label: string;
  columnKey: SupplierSortKey;
  numeric: boolean;
  query: SupplierQuery;
  hrefFor: (patch: Partial<SupplierQuery>) => string;
}) {
  const active = query.sortKey === columnKey;
  return (
    <TableHead numeric={numeric}>
      <Link
        href={hrefFor({ sortKey: columnKey, desc: active ? !query.desc : false })}
        scroll={false}
        className="inline-flex items-center gap-1 uppercase tracking-wider outline-accent hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        {label}
        {active && <span aria-hidden>{query.desc ? "▼" : "▲"}</span>}
      </Link>
    </TableHead>
  );
}

/** What the server answered with, beside the page of rows itself. Optional as a
 *  group: a caller that hands over the whole list gets it rendered whole. */
export type SupplierPaging = {
  /** Suppliers the shop has, whatever is in the search box. */
  total: number;
  /** Suppliers the text matched — what the pager counts against. */
  matched: number;
  page: number;
  pageCount: number;
  from: number;
  query: SupplierQuery;
  /** The full matched list, fetched at click time. The export is the list the
   *  reader filtered to, not the twenty-five rows they are looking at. */
  exportRows: () => Promise<SupplierRow[]>;
};

const WHOLE_LIST: SupplierQuery = { search: "", sortKey: "name", desc: false, page: 0 };

export function SuppliersView({
  rows,
  paging,
  unassignedBrands,
  supplierOptions,
  assignableProducts,
  defaultCurrency,
  canManage,
}: {
  /** One page of suppliers, already searched and sorted by the server. */
  rows: SupplierRow[];
  paging?: SupplierPaging;
  unassignedBrands: UnassignedBrand[];
  supplierOptions: SupplierOption[];
  assignableProducts: AssignableProduct[];
  defaultCurrency: string;
  canManage: boolean;
}) {
  const {
    total = rows.length,
    matched = rows.length,
    page = 0,
    pageCount = 1,
    from = 1,
    query = WHOLE_LIST,
    exportRows,
  } = paging ?? {};
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<SupplierRow | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();
  const [pending, startTransition] = useTransition();

  const hrefFor = (patch: Partial<SupplierQuery>) =>
    `/suppliers${supplierQueryToSearch(withSupplierQuery(query, patch))}`;

  function handleResult(result: SupplierActionResult) {
    if (result.ok) {
      setError(null);
      setNotice(result.message ?? "Done.");
    } else {
      setNotice(null);
      setError(result.error);
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

  async function remove(row: SupplierRow) {
    const ok = await confirm({
      title: `Remove ${row.name}?`,
      body: DELETE_WARNING,
      confirmLabel: "Remove supplier",
    });
    if (!ok) return;
    run(row.id, () => deleteSupplierAction({ supplierId: row.id }));
  }

  const sortHead = (label: string, k: SupplierSortKey, numeric = false) => (
    <SortHead label={label} columnKey={k} numeric={numeric} query={query} hrefFor={hrefFor} />
  );

  return (
    <div className="space-y-6">
      {dialog}
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
          defaultCurrency={defaultCurrency}
          supplier={editing === "new" ? null : editing}
          onResult={handleResult}
          onClose={() => setEditing(null)}
        />
      )}

      {/* Screen actions sit above the table rather than inside its card: the
          page heading already names what this is, so a card header repeating it
          only pushed the rows further down. */}
      <div className="flex flex-wrap items-center gap-2">
        <ExportBar
          loadRows={exportRows ?? (async () => rows)}
          count={matched}
          columns={exportColumns}
          filename="suppliers"
          size="md"
        />
        {canManage && !importing && (
          <Button variant="ghost" onClick={() => setImporting(true)}>
            Import CSV
          </Button>
        )}
        {canManage && editing !== "new" && (
          <Button onClick={() => setEditing("new")}>Add supplier</Button>
        )}
      </div>

      <Card>
        {total > 0 && (
          /* The form posts `q` itself and carries no page, so a new search
             always lands on the first page of its own results. */
          <TableSearch
            action="/suppliers"
            value={query.search}
            hidden={sortFields(query)}
            placeholder="Search by name, group, country or email…"
            matched={query.search ? matched : null}
            total={total}
            clearHref={hrefFor({ search: "" })}
            label="Search suppliers"
          />
        )}
        <CardContent className="p-0 py-2">
          {total === 0 ? (
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
            <Table dense>
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
                {/* The column is always here so the table reads the same for
                    everyone; the buttons inside it stay with the permission. */}
                <TableHead>Actions</TableHead>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
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
                              className="min-h-6 px-2"
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
                    <TableCell>
                      {canManage && (
                        <div className="flex items-center gap-1.5">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="min-h-7 px-2"
                            onClick={() => setEditing(row)}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="min-h-7 px-2"
                            loading={pending && busyId === row.id}
                            onClick={() => remove(row)}
                          >
                            Remove
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {total > 0 && matched === 0 && (
            <p className="px-4 py-6 text-sm text-ink-muted">
              No supplier matches that. Clear the search to see all {total}.
            </p>
          )}
        </CardContent>
        {pageCount > 1 && (
          <Pager
            page={page}
            pageCount={pageCount}
            from={from}
            to={from + rows.length - 1}
            total={matched}
            pageHref={(next) => hrefFor({ page: next })}
            label="Supplier pages"
          />
        )}
      </Card>
    </div>
  );
}

/** The sort the reader chose, as hidden fields on the search form. A GET form
 *  submits only its own inputs, so without these, searching would quietly put
 *  the list back in name order. Page is deliberately absent. */
function sortFields(query: SupplierQuery): { name: string; value: string }[] {
  return [
    ...(query.sortKey !== "name" ? [{ name: "sort", value: query.sortKey }] : []),
    ...(query.desc ? [{ name: "dir", value: "desc" }] : []),
  ];
}

function driftTitle(row: SupplierRow): string {
  const delta = row.drift.deltaDays != null ? Math.abs(row.drift.deltaDays) : null;
  const dir = row.drift.direction === "later" ? "later" : "earlier";
  if (delta == null) return "Learned lead time has drifted from the typed value.";
  return `Deliveries are running ${delta} day${delta === 1 ? "" : "s"} ${dir} than the ${row.leadTimeTypedDays}d you set.`;
}

/**
 * On-time grades a delivery against the date promised when the order went out,
 * and that date is only set when the supplier had a lead time at the time. So a
 * supplier with plenty of deliveries and no lead time scores nothing — which
 * used to look exactly like a supplier with no deliveries. Say which it is, and
 * what fixes it.
 */
function onTimeGap(row: SupplierRow): { label: string; help: string } | null {
  if (row.onTimePct != null) return null;
  if (row.onTimeStatus === "awaiting_completion") {
    return {
      label: "On-time pending",
      help: "On-time is scored once a delivery is fully checked in.",
    };
  }
  if (row.onTimeStatus !== "no_promised_date") return null;
  if (row.leadTimeTypedDays != null) {
    return {
      label: "On-time from your next order",
      help: "These orders went out before this supplier had a delivery time, so there was no promised date to judge them against. Orders you send from now on are scored.",
    };
  }
  return {
    label: "On-time needs a lead time",
    help:
      row.learnedLeadDays != null
        ? `Nothing was promised on these orders, so no delivery can be called on time. Give this supplier a delivery time — "Use learned" takes the ${row.learnedLeadDays} days these deliveries actually took — and orders you send from now on are scored.`
        : "Nothing was promised on these orders, so no delivery can be called on time. Add this supplier's usual delivery time under Edit, and orders you send from now on are scored.",
  };
}

function ScoreBadges({ row }: { row: SupplierRow }) {
  if (row.deliveriesTracked === 0) {
    return <span className="text-xs text-ink-faint">No deliveries yet</span>;
  }
  const gap = onTimeGap(row);
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {gap && (
        <span className="text-xs text-ink-muted" title={gap.help}>
          {gap.label}
        </span>
      )}
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
