import Link from "next/link";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { getProductTimeline, searchTimelineProducts } from "@/lib/data/product-timeline";
import { HistoryExport } from "./history-export";
import { reportTabHref } from "./tabs";

/**
 * Searchable product history, with serializable event rows for CSV export.
 */
export async function HistoryTab({ tenantId, timezone, query = "", productId, lenses }: { tenantId: string; timezone: string; query?: string; productId?: string; lenses?: { range?: string; class?: string; from?: string; to?: string } }) {
  const [matches, timeline] = await Promise.all([
    searchTimelineProducts(tenantId, query),
    productId ? getProductTimeline(tenantId, productId, timezone) : Promise.resolve(null),
  ]);
  return (
    <Card className="min-w-0 max-w-full">
      <CardHeader title="Order & SKU history" subtitle="Search a product to follow its forecasts, orders, deliveries, sales and empty-shelf observations over the last year." />
      <CardContent className="space-y-5">
        <form key={query} action="/insights" method="get" className="flex min-w-0 flex-wrap items-end gap-2">
          <input type="hidden" name="tab" value="history" />
          {Object.entries(lenses ?? {}).map(([name, value]) => value ? <input key={name} type="hidden" name={name} value={value} /> : null)}
          <label className="w-full min-w-0 space-y-1 text-sm sm:max-w-md">Product name or SKU
            <input name="q" defaultValue={query} maxLength={120} className="block h-10 w-full min-w-0 rounded-md border border-edge bg-surface px-3 py-2" />
          </label>
          <button type="submit" className="rounded-md border border-edge px-3 py-2 text-sm hover:bg-surface-2">Search</button>
        </form>
        {query && <ul className="space-y-2" aria-label="Matching products">
          {matches.map(p => <li key={p.id} className="min-w-0"><Link className="break-words text-sm text-accent-ink hover:underline" href={`${reportTabHref("history", lenses)}&q=${encodeURIComponent(query)}&product=${encodeURIComponent(p.id)}`}>{p.title} · {p.sku}</Link></li>)}
          {!matches.length && <li className="text-sm text-ink-muted">No matching products in this workspace.</li>}
        </ul>}
        {productId && !timeline && <p className="text-sm text-ink-muted">This product is unavailable in this workspace.</p>}
        {timeline && <section className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Link href={`/stock/${timeline.product.id}`} className="min-w-0 break-words font-medium text-accent-ink hover:underline">{timeline.product.title} · {timeline.product.sku}</Link>
            <HistoryExport sku={timeline.product.sku} events={timeline.events} />
          </div>
          <p className="text-xs text-ink-muted">Recorded events since {timeline.since.slice(0, 10)}. Forecasts appear only where recommendation records are still retained. Dates use stored event dates (UTC for timestamped actions). Receipts show cumulative line totals at the latest receipt, not individual delivery quantities.</p>
          {timeline.truncated && <p className="text-sm text-ink-muted">Showing up to 1,000 recent recorded events; earlier entries may be omitted.</p>}
          {!timeline.events.length ? <p className="text-sm text-ink-muted">No recorded events in this period.</p> : <div role="region" aria-label="Product history events" tabIndex={0} className="max-w-full overflow-x-auto rounded-md border border-edge focus-visible:outline-2 focus-visible:outline-accent"><table className="w-full min-w-[36rem] text-left text-sm [&_th]:px-3 [&_th]:py-3 [&_td]:px-3 [&_td]:align-top">
            <caption className="sr-only">Recorded product events, newest first. Dates use UTC for timestamped actions.</caption>
            <thead className="bg-surface-2"><tr className="border-b border-edge"><th className="py-2">Recorded date</th><th className="min-w-64">Event</th><th className="text-right">Units</th><th className="pl-3">Source</th></tr></thead>
            <tbody>{timeline.events.map(e => <tr key={e.id} className="border-b border-edge"><td className="whitespace-nowrap py-3 pr-3">{e.at.slice(0, 10)}</td><td className="py-3 pr-3">{e.label}{e.detail && <div className="text-xs text-ink-muted">{e.detail}</div>}</td><td className="text-right font-mono">{e.qty ?? "—"}</td><td className="pl-3 text-ink-muted">{e.actor}</td></tr>)}</tbody>
          </table></div>}
        </section>}
      </CardContent>
    </Card>
  );
}
