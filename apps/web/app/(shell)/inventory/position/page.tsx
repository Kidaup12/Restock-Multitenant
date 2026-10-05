import Link from "next/link";
import type { Metadata } from "next";
import { activeMembership, requireSession } from "@/lib/auth";
import { getInventoryPosition } from "@/lib/data/inventory-position";
import { POSITION_WINDOWS, positionWindow } from "@/lib/inventory/position";
import type { RawSearchParams } from "@/lib/catalogue";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Card } from "@/components/ui/card";
import { PositionExport } from "./position-export";

export const metadata: Metadata = { title: "Inventory position" };
const PAGE_SIZE = 100;
const number = (value: number, decimals = 0) => value.toLocaleString("en-GB", { maximumFractionDigits: decimals });

export default async function InventoryPositionPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const session = await requireSession();
  const [membership, params] = await Promise.all([activeMembership(session.user.id), searchParams]);
  if (!membership) return <EmptyState title="No workspace yet" description="Join a workspace to see inventory position." />;
  const windowDays = positionWindow(params.days);
  const search = (Array.isArray(params.q) ? params.q[0] ?? "" : params.q ?? "").slice(0, 200);
  const report = await getInventoryPosition(membership.tenantId, windowDays, search);
  const pages = Math.max(1, Math.ceil(report.rows.length / PAGE_SIZE));
  const requested = Number(Array.isArray(params.page) ? params.page[0] : params.page);
  const page = Number.isFinite(requested) ? Math.max(1, Math.min(pages, Math.floor(requested))) : 1;
  const rows = report.rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const href = (next: number) => `/inventory/position?${new URLSearchParams({ days: String(windowDays), q: search, page: String(next) })}`;
  const totals = report.rows.reduce((sum, r) => ({ stock: sum.stock + r.onHand, sold: sum.sold + r.soldUnits, inbound: sum.inbound + r.inbound }), { stock: 0, sold: 0, inbound: 0 });
  const period = `${report.startKey} to ${report.endKey}`;

  return <div className="space-y-6">
    <PageHeader title="Inventory position" breadcrumbs={[{ label: "Inventory", href: "/inventory" }, { label: "Position" }]}
      description="Actual sales over your chosen window, alongside the shop’s sellable stock."
      actions={<PositionExport windowDays={windowDays} search={search} count={report.rows.length} period={period} />} />
    <form className="flex flex-wrap items-end gap-3" method="get">
      <label className="text-sm">Window
        <select name="days" defaultValue={windowDays} className="ml-2 rounded border border-line bg-surface px-3 py-2">
          {POSITION_WINDOWS.map(days => <option key={days} value={days}>{days} days</option>)}
        </select>
      </label>
      <label className="text-sm">Search
        <input name="q" defaultValue={search} placeholder="Product, SKU or supplier" className="ml-2 rounded border border-line bg-surface px-3 py-2" maxLength={200} />
      </label>
      <button type="submit" className="rounded border border-line px-4 py-2 text-sm">Apply</button>
    </form>
    <Card className="space-y-2 p-4 text-sm">
      <p>{period} · {number(report.rows.length)} products · {number(totals.sold)} units sold · {number(totals.stock)} sellable now · {number(totals.inbound)} inbound</p>
      <p className="text-ink-muted">Sales/day divides units sold by the window minus confirmed empty-shelf days. A minimum of 3–7 days protects thin histories. This is a window average; forecast demand can differ. Coverage shows observed in-stock and out days; missing days remain unknown. Today is included.</p>
      <p className="text-ink-muted">Opening uses the first day’s snapshot when available. An estimated opening is current stock plus units sold; it excludes receipts and transfers and is not a stock reconciliation. Cover and inbound are shop-wide. Warehouse stock is separate on Inventory.</p>
    </Card>
    {rows.length === 0 ? <EmptyState title="No matching products" description="Change your search or sync the catalogue to populate this report." /> : <Card className="overflow-x-auto">
      <table className="w-full whitespace-nowrap text-sm">
        <caption className="sr-only">Shop-wide inventory position, {period}. Ranked by ABC then adjusted sales per day.</caption>
        <thead><tr className="border-b border-line text-left text-ink-muted">
          {["Product", "ABC", "Opening", "Sold", "Current", "Inbound", "In-stock / out days", "Observed days", "Sales/day", "Cover days"].map(label => <th key={label} scope="col" className="px-3 py-3 font-medium">{label}</th>)}
        </tr></thead>
        <tbody>{rows.map(row => <tr key={row.productId} className="border-b border-line last:border-0">
          <th scope="row" className="max-w-80 whitespace-normal px-3 py-3 text-left font-normal"><span className="font-medium">{row.title}</span><span className="block text-xs text-ink-muted">{row.sku}{row.supplier ? ` · ${row.supplier}` : ""}</span></th>
          <td className="px-3 py-3">{row.abc ?? "Unrated"}</td>
          <td className="px-3 py-3">{number(row.opening)}{row.openingEstimated && <span className="block text-xs text-ink-muted">Estimated</span>}</td>
          <td className="px-3 py-3">{number(row.soldUnits)}</td><td className="px-3 py-3">{number(row.onHand)}</td><td className="px-3 py-3">{number(row.inbound)}</td>
          <td className="px-3 py-3">{row.inStockDays} / {row.stockoutDays}</td><td className="px-3 py-3">{row.observedDays} / {windowDays}</td>
          <td className="px-3 py-3" title={`${row.soldUnits} units / ${row.effectiveDays} effective days`}>{number(row.salesPerDay, 2)}</td>
          <td className="px-3 py-3">{row.coverDays == null ? "—" : number(row.coverDays, 1)}</td>
        </tr>)}</tbody>
      </table>
    </Card>}
    <nav aria-label="Report pages" className="flex items-center gap-4 text-sm">
      {page > 1 && <Link href={href(page - 1)}>Previous</Link>}<span>Page {page} of {pages} · exports include all matching products</span>{page < pages && <Link href={href(page + 1)}>Next</Link>}
    </nav>
  </div>;
}
