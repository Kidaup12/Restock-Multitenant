"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ChevronDownIcon } from "@/components/icons";
import { cn } from "@/lib/cn";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * Week by week, with the products behind each week.
 *
 * "Which weeks were bad" on its own is a chart. The reason this is a table is
 * the row underneath: the products that were actually off the shelf, so the
 * answer to a bad week is a list to act on rather than a shape to interpret.
 *
 * Dates arrive preformatted from the server. Nothing but strings and numbers
 * crosses into this component — a Date or a closure over the boundary is the
 * fault that once made a whole page 500 for every visitor.
 */

export type PeriodCulpritView = {
  productId: string;
  sku: string;
  title: string;
  emptyDays: number;
};

export type PeriodRowView = {
  key: string;
  label: string;
  emptyRatePct: number;
  emptyProductDays: number;
  observedProductDays: number;
  daysCovered: number;
  deadStockSkus: number | null;
  unitsSold: number;
  culprits: PeriodCulpritView[];
};

export function PeriodTableView({ rows }: { rows: PeriodRowView[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());

  function toggle(key: string) {
    setOpen((set) => {
      const next = new Set(set);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <Card>
      <CardHeader
        title="Week by week"
        subtitle="How often shelves were empty, what was sitting dead, and what sold. Open a week to see which products were behind it."
      />
      <CardContent className="pt-3">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableHead>Week of</TableHead>
              <TableHead numeric>Empty shelves</TableHead>
              <TableHead numeric>Dead stock</TableHead>
              <TableHead numeric>Units sold</TableHead>
              <TableHead>
                <span className="sr-only">Show products</span>
              </TableHead>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const expanded = open.has(row.key);
                return (
                  <Fragment key={row.key}>
                    <TableRow>
                      <TableCell>
                        <span className="font-medium text-ink">{row.label}</span>
                        {row.daysCovered < 7 && (
                          <span className="ml-2 text-xs text-ink-faint">
                            {row.daysCovered} days recorded
                          </span>
                        )}
                      </TableCell>
                      <TableCell numeric>
                        <span className="font-mono">{row.emptyRatePct}%</span>
                        <span className="ml-2 text-xs text-ink-faint">
                          {row.emptyProductDays}/{row.observedProductDays}
                        </span>
                      </TableCell>
                      <TableCell numeric>
                        {/* Absent, never zero: a week with no snapshot cannot be
                            reported as a week with nothing sitting dead. */}
                        {row.deadStockSkus == null ? (
                          <span className="text-xs text-ink-faint">—</span>
                        ) : (
                          <span className="font-mono">{row.deadStockSkus}</span>
                        )}
                      </TableCell>
                      <TableCell numeric>
                        <span className="font-mono">{row.unitsSold}</span>
                      </TableCell>
                      <TableCell>
                        {row.culprits.length > 0 && (
                          <button
                            type="button"
                            onClick={() => toggle(row.key)}
                            aria-expanded={expanded}
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-ink-muted hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                          >
                            {expanded ? "Hide" : `${row.culprits.length} products`}
                            <ChevronDownIcon
                              className={cn("size-3 transition-transform", expanded && "rotate-180")}
                            />
                          </button>
                        )}
                      </TableCell>
                    </TableRow>
                    {expanded && (
                      <TableRow>
                        {/* A raw cell: TableCell takes no colSpan, and the
                            checklist's expand row spans the same way. */}
                        <td colSpan={5} className="px-5 pt-0 pb-3">
                          <ul className="space-y-1 py-1">
                            {row.culprits.map((c) => (
                              <li key={c.productId} className="flex flex-wrap items-center gap-2 text-sm">
                                <Link
                                  href={`/products/${c.productId}`}
                                  className="rounded-sm font-medium text-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                                >
                                  {c.title}
                                </Link>
                                <span className="font-mono text-xs text-ink-muted">{c.sku}</span>
                                <Badge tone="warning">
                                  empty {c.emptyDays} {c.emptyDays === 1 ? "day" : "days"}
                                </Badge>
                              </li>
                            ))}
                          </ul>
                        </td>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
