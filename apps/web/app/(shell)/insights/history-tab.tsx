import Link from "next/link";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { getProductTimeline, searchTimelineProducts } from "@/lib/data/product-timeline";
import { HistoryExport } from "./history-export";

/**
 * Searchable product history, with serializable event rows for CSV export.
 */
export async function HistoryTab({ tenantId, timezone, query = "", productId }: { tenantId: string; timezone: string; query?: string; productId?: string }) {
  const [matches, timeline] = await Promise.all([
    searchTimelineProducts(tenantId, query),
    productId ? getProductTimeline(tenantId, productId, timezone) : Promise.resolve(null),
  ]);
  return (
    <Card>
      <CardHeader title="Order & SKU history" subtitle="Search a product to follow its forecasts, orders, deliveries, sales and empty-shelf observations over the last year." />
      <CardContent className="space-y-5">
        <form action="/insights" method="get" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="tab" value="history" />
          <label className="space-y-1 text-sm">Product name or SKU
            <input name="q" defaultValue={query} maxLength={120} className="block rounded-md border border-edge bg-surface px-3 py-2" />
          </label>
          <button type="submit" className="rounded-md border border-edge px-3 py-2 text-sm hover:bg-surface-muted">Search</button>
        </form>
        {query && <ul className="space-y-2" aria-label="Matching products">
          {matches.map(p => <li key={p.id}><Link className="text-sm text-accent-ink hover:underline" href={`/insights?tab=history&q=${encodeURIComponent(query)}&product=${encodeURIComponent(p.id)}`}>{p.title} · {p.sku}</Link></li>)}
          {!matches.length && <li className="text-sm text-ink-muted">No matching products in this workspace.</li>}
        </ul>}
        {productId && !timeline && <p className="text-sm text-ink-muted">This product is unavailable in this workspace.</p>}
        {timeline && <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Link href={`/stock/${timeline.product.id}`} className="font-medium text-accent-ink hover:underline">{timeline.product.title} · {timeline.product.sku}</Link>
            <HistoryExport sku={timeline.product.sku} events={timeline.events} />
          </div>
          <p className="text-xs text-ink-muted">Recorded events since {timeline.since.slice(0, 10)}. Forecasts appear only where recommendation records are still retained. Dates use stored event dates (UTC for timestamped actions). Receipts show cumulative line totals at the latest receipt, not individual delivery quantities.</p>
          {timeline.truncated && <p className="text-sm text-ink-muted">Showing up to 1,000 recent recorded events; earlier entries may be omitted.</p>}
          {!timeline.events.length ? <p className="text-sm text-ink-muted">No recorded events in this period.</p> : <div className="overflow-x-auto"><table className="w-full text-left text-sm">
            <thead><tr className="border-b border-edge"><th className="py-2">Date</th><th>Event</th><th className="text-right">Units</th><th className="pl-3">Source</th></tr></thead>
            <tbody>{timeline.events.map(e => <tr key={e.id} className="border-b border-edge"><td className="whitespace-nowrap py-3 pr-3">{e.at.slice(0, 10)}</td><td className="py-3 pr-3">{e.label}{e.detail && <div className="text-xs text-ink-muted">{e.detail}</div>}</td><td className="text-right font-mono">{e.qty ?? "—"}</td><td className="pl-3 text-ink-muted">{e.actor}</td></tr>)}</tbody>
          </table></div>}
        </section>}
      </CardContent>
    </Card>
  );
}
