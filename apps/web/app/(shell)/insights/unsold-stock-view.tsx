"use client";
import { useState } from "react";
import Link from "next/link";
import type { CatalogueRow } from "@/lib/data/stock";
import type { UnsoldReason } from "@/lib/data/today";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { CostValue } from "@/components/ui/cost-value";
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from "@/components/ui/table";
import { UnsoldStockExport } from "@/components/inventory/unsold-export";

const labels: Record<UnsoldReason, string> = { new_product: "Recent product record · under 60 days", insufficient_stock_history: "Fewer than 14 observed in-stock days", unknown_age: "Product age unknown", dead: "Also counted as dead stock" };
export function UnsoldStockView({ rows, reasons, canViewCosts }: { rows: CatalogueRow[]; reasons: Record<string, UnsoldReason>; canViewCosts: boolean }) {
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const visible = rows.filter(row => !query || `${row.title} ${row.sku} ${row.vendor ?? ""}`.toLowerCase().includes(query));
  const cost = canViewCosts ? visible.reduce((sum, row) => sum + (row.moneyAtRestKes ?? 0), 0) : null;
  return <Card>
    <CardHeader title="Unsold stock" subtitle="Current stock with no recorded positive sale, including products in the 60-day grace period. The selected report dates do not change this current-stock list." />
    <CardContent className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm"><strong>{visible.length} stocked products</strong>{canViewCosts && <> · <CostValue amount={cost} canViewCosts compact /> at cost</>}</p><UnsoldStockExport rows={visible} reasons={reasons} canViewCosts={canViewCosts} /></div>
      <p className="text-xs text-ink-muted">New or recently imported product records, unknown ages and limited stock observations can prevent a dead-stock label. They remain visible here. Unsold and dead stock can overlap; do not add their counts or values together.</p>
      <Input aria-label="Search unsold stock" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search all unsold products by name, SKU or brand" className="w-full sm:max-w-md" />
      <p className="text-xs text-ink-muted">Showing {visible.length} of {rows.length} products in this class filter. Every match is included in the table and export.</p>
      {visible.length ? <Table boxed><TableHeader><TableHead>Product</TableHead><TableHead numeric>Stock</TableHead><TableHead>Dead-stock status</TableHead>{canViewCosts && <TableHead numeric>Stock value</TableHead>}</TableHeader><TableBody>{visible.map(row => <TableRow key={row.productId}><TableCell className="min-w-48 max-w-80 whitespace-normal"><Link href={`/products/${row.productId}`} className="text-accent-ink hover:underline">{row.title}</Link><div className="text-xs text-ink-muted">{row.sku}</div></TableCell><TableCell numeric>{row.onHandUnits}</TableCell><TableCell className="max-w-64 whitespace-normal">{labels[reasons[row.productId]]}</TableCell>{canViewCosts && <TableCell numeric><CostValue amount={row.moneyAtRestKes} canViewCosts /></TableCell>}</TableRow>)}</TableBody></Table> : <p className="text-sm text-ink-muted">No unsold products match this view.</p>}
    </CardContent>
  </Card>;
}
