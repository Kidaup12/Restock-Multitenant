import Link from "next/link";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { getPeriodInventory } from "@/lib/data/period-inventory";
import type { ReportRange } from "@/lib/data/report-range";
import type { AbcKey } from "@/lib/data/abc-lens";
import { formatMoney, formatNumber } from "@/lib/money";
import { PurchasingHistoryExport } from "./purchasing-history-export";
export async function PurchasingHistory({ tenantId, canViewCosts, currency, abc, period, weeks }: {
    tenantId: string;
    canViewCosts: boolean;
    currency: string;
    abc: AbcKey;
    period?: ReportRange;
    weeks: number;
}) {
    const report = await getPeriodInventory(tenantId, { canViewCosts, abc, period, weeks });
    const money = (value: number | null) => value == null ? "—" : formatMoney(value, currency);
    return <Card>
    <CardHeader title="Purchasing and stock by week" subtitle={`Placed purchase orders, quantities above their saved recommendation, and stock held at period end. Dead stock means no sales for ${report.deadWindowDays} days after previously selling; excess stock exceeds 90 days at that week's sales pace.`}/>
    <CardContent className="space-y-4">
      <p className="text-xs text-ink-muted">Above-recommendation units can reflect supplier minimums or an owner&apos;s decision; they are not automatically a buying mistake. Draft and cancelled purchase orders are excluded. Stock measures use only products with a snapshot on the final selected day of the week. Stock values use current catalogue costs. Partial weeks can give a noisy sales pace.</p>
      <PurchasingHistoryExport rows={report.rows} canViewCosts={canViewCosts} currency={currency}/>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b border-edge"><th className="py-2">Period</th><th className="text-right">Ordered units</th>{canViewCosts && <th className="text-right">Ordered cost</th>}<th className="text-right">Above saved recommendation</th>{canViewCosts && <th className="text-right">Extra cost</th>}<th className="text-right">Dead SKUs</th>{canViewCosts && <th className="text-right">Dead stock cost</th>}<th className="text-right">Excess SKUs</th>{canViewCosts && <th className="text-right">Excess cost</th>}</tr></thead>
        <tbody>{report.rows.map(row => <tr key={row.week} className="border-b border-edge"><td className="py-3 pr-3 whitespace-nowrap">{row.from} – {row.through}<div className="text-xs text-ink-muted">{row.snapshotDays}/{row.days} snapshot days{row.days < 7 ? " · partial week" : ""}</div><div className="text-xs text-ink-muted">{row.endObservedProducts}/{row.eligibleProducts} products observed at period end</div></td><td className="text-right">{formatNumber(row.orderedUnits)}</td>{canViewCosts && <td className="text-right whitespace-nowrap">{money(row.orderedValueKes)}</td>}<td className="text-right">{row.overorderUnits == null ? "—" : formatNumber(row.overorderUnits)}{row.unmeasuredLines > 0 && <div className="text-xs text-ink-muted">{row.unmeasuredLines} lines without a saved recommendation</div>}</td>{canViewCosts && <td className="text-right whitespace-nowrap">{money(row.overorderValueKes)}</td>}<td className="text-right">{row.deadCount ?? "—"}</td>{canViewCosts && <td className="text-right whitespace-nowrap">{money(row.deadValueKes)}</td>}<td className="text-right">{row.overstockCount ?? "—"}</td>{canViewCosts && <td className="text-right whitespace-nowrap">{money(row.overstockValueKes)}</td>}</tr>)}</tbody>
      </table></div>
      <div className="space-y-2">{report.rows.filter(row => row.details.length > 0).map(row => <details key={row.week} className="rounded-md border border-edge p-3"><summary className="cursor-pointer text-sm font-medium">{row.from} – {row.through}: products behind the figures</summary><ul className="mt-3 space-y-2">{row.details.slice(0, 100).map((line, index) => <li key={`${line.kind}-${line.productId}-${index}`} className="flex flex-wrap justify-between gap-2 text-sm"><Link className="text-accent-ink hover:underline" href={`/stock/${line.productId}`}>{line.title} · {line.sku}</Link><span>{line.kind} · {formatNumber(line.units)} units{canViewCosts ? ` · ${money(line.valueKes)}` : ""}</span></li>)}</ul>{row.details.length > 100 && <p className="mt-2 text-xs text-ink-muted">Showing 100 of {row.details.length} detail lines. The detail export includes all lines.</p>}</details>)}</div>
    </CardContent>
  </Card>;
}
