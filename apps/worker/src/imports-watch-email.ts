import type { ImportsWatch, WatchLine } from "./imports-watch";

/**
 * Render an ImportsWatch as the every-other-day email — the original's approved
 * layout: class chip + product | rate | order | shops | warehouse | en route |
 * total. Section headers carry the full count and cost (rows are capped). The
 * shop's own currency, titles HTML-escaped, and a plain-text twin.
 */

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const short = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (a >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${Math.round(n)}`;
};

const abcChip = (abc: WatchLine["abc"]) => {
  const bg = abc === "A" ? "#db5586" : abc === "B" ? "#f2d0dd" : "#eee";
  const fg = abc === "A" ? "#fff" : abc === "B" ? "#a62f5c" : "#888";
  return `<span style="display:inline-block;width:18px;height:18px;line-height:18px;text-align:center;border-radius:5px;background:${bg};color:${fg};font-size:11px;font-weight:700">${abc}</span>`;
};

const TH = (t: string, right = true) =>
  `<th style="text-align:${right ? "right" : "left"};font-size:10px;color:#aaa;text-transform:uppercase;letter-spacing:.3px;padding:4px;border-bottom:2px solid #333">${t}</th>`;

function table(lines: WatchLine[]): string {
  const td = (v: string | number, style = "") =>
    `<td style="padding:6px 4px;font-size:12px;text-align:right;white-space:nowrap;border-bottom:1px solid #eee;${style}">${v}</td>`;
  const rows = lines
    .map((l) => {
      const totalColour = l.total <= 0 ? "#c0392b" : l.total < 10 ? "#b8791a" : "#333";
      return `<tr>
    <td style="padding:6px 4px;font-size:13px;border-bottom:1px solid #eee">${abcChip(l.abc)} ${escapeHtml(l.title)}</td>
    ${td(`${l.runRate.toFixed(2)}/d`, "color:#888")}
    ${td(l.orderQty ?? "-", "font-size:13px;font-weight:600")}
    ${td(l.shops, "color:#555")}
    ${td(l.warehouse, "color:#555")}
    ${td(l.enRoute > 0 ? l.enRoute : "-", l.enRoute > 0 ? "color:#2a7ab0;font-weight:600" : "color:#ccc")}
    ${td(l.total, `font-weight:700;color:${totalColour}`)}
  </tr>`;
    })
    .join("");
  return `<table style="width:100%;border-collapse:collapse;margin-top:4px">
    <tr>${TH("Product", false)}${TH("Rate")}${TH("Order")}${TH("Shops")}${TH("Warehouse")}${TH("En route")}${TH("Total")}</tr>
    ${rows}
  </table>`;
}

function section(title: string, colour: string, hint: string, lines: WatchLine[], fullCount: number, emptyMsg: string): string {
  const header = `<h3 style="font-size:14px;margin:26px 0 4px;color:${colour}">${title}</h3>`;
  if (lines.length === 0) return `${header}<p style="color:#2f8a4c;font-size:13px;margin:4px 0 0">${emptyMsg}</p>`;
  const more =
    fullCount > lines.length
      ? `<p style="color:#aaa;font-size:11px;margin:6px 0 0">+${fullCount - lines.length} more in the Restock planner</p>`
      : "";
  return `${header}<p style="color:#666;font-size:12px;margin:2px 0 6px">${hint}</p>${table(lines)}${more}`;
}

export function renderImportsWatchEmail(r: ImportsWatch): { subject: string; html: string; text: string } {
  const cur = r.currency;
  const name = escapeHtml(r.tenantName);
  const subject = `Imports Watch: ${r.tenantName} · ${r.urgentCount} urgent · ${r.dateLabel}`;
  const intro = `${r.watchedCount} products that take ${r.leadDays}+ days to arrive — late reorders here cost the most.`;

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f6f3f4">
  <div style="max-width:640px;margin:0 auto;padding:24px 16px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
    <div style="background:#fff;border-radius:12px;padding:24px;border:1px solid #eee">
      <p style="margin:0;color:#db5586;font-weight:700;font-size:13px;letter-spacing:.5px">WEZESHA RESTOCK</p>
      <h2 style="margin:4px 0 2px;font-size:19px">Imports Watch · ${name}</h2>
      <p style="margin:0 0 14px;color:#888;font-size:13px">${r.dateLabel} · ${intro}</p>
      <p style="margin:0 0 4px;font-size:14px"><b style="color:${r.urgentCount > 0 ? "#c0392b" : "#2f8a4c"}">${r.urgentCount} urgent</b> (critical, or out of stock and selling fast) · ${r.attentionCount} need attention in total.</p>
      ${section(`Bestsellers (top ${r.bestsellers.length} by run rate)`, "#333", "Your fastest movers among these, and where their stock sits today.", r.bestsellers, r.bestsellers.length, "No sales yet.")}
      ${section(`Critical reorders: ${r.criticalsCount} items · ${cur} ${short(r.criticalsBudgetKes)}`, "#b8791a", "Selling fast with a week or less of cover left. Order these first.", r.criticals, r.criticalsCount, "Nothing critical today.")}
      ${section(`Out of stock, selling fast: ${r.oosHighCount} items · ${cur} ${short(r.oosHighBudgetKes)}`, "#c0392b", "Nothing on the shelf and still selling fast. Losing sales until restocked.", r.oosHigh, r.oosHighCount, "No fast movers are out of stock.")}
      ${section(`Out of stock, slow movers: ${r.oosLowCount} items · ${cur} ${short(r.oosLowBudgetKes)}`, "#a04a4a", "Out of stock but slow. Reorder calmly with the next consignment.", r.oosLow, r.oosLowCount, "No slow movers are out of stock.")}
      ${section(`Other reorders: ${r.othersCount} items · ${cur} ${short(r.othersBudgetKes)}`, "#555", "Slower movers with stock left that the planner still wants topped up.", r.others, r.othersCount, "Nothing else to reorder.")}
      <p style="margin:24px 0 0;font-size:14px;border-top:2px solid #333;padding-top:10px"><b>Total reorder budget: ${cur} ${short(r.totalBudgetKes)}</b> across ${r.totalOrderLines} lines.</p>
      <p style="color:#aaa;font-size:11px;margin:14px 0 0">Shops = selling locations · Warehouse = warehouse stock · En route = already on order · Total = all three. Rate is the one your dashboard shows; order and cost follow the Restock planner, at supplier cost.</p>
    </div>
    <p style="color:#bbb;font-size:11px;text-align:center;margin:14px 0 0">Sent every other day by Wezesha Restock. Turn it off in Settings → Notifications.</p>
  </div></body></html>`;

  const tline = (l: WatchLine) =>
    `  [${l.abc}] ${l.title.slice(0, 42).padEnd(43)}${l.runRate.toFixed(2)}/d  order ${String(l.orderQty ?? "-").padStart(4)}  shops ${String(l.shops).padStart(4)}  wh ${String(l.warehouse).padStart(4)}  en route ${String(l.enRoute).padStart(4)}  total ${String(l.total).padStart(4)}`;
  const tsection = (title: string, lines: WatchLine[], fullCount: number) =>
    `\n${title}\n${lines.length === 0 ? "  none" : lines.map(tline).join("\n")}${fullCount > lines.length ? `\n  +${fullCount - lines.length} more in the Restock planner` : ""}`;

  const text = [
    `Imports Watch: ${r.tenantName} · ${r.dateLabel}`,
    `${intro} ${r.urgentCount} urgent, ${r.attentionCount} need attention.`,
    tsection(`BESTSELLERS (top ${r.bestsellers.length} by run rate)`, r.bestsellers, r.bestsellers.length),
    tsection(`CRITICAL REORDERS (${r.criticalsCount} · ${cur} ${short(r.criticalsBudgetKes)})`, r.criticals, r.criticalsCount),
    tsection(`OUT OF STOCK, SELLING FAST (${r.oosHighCount} · ${cur} ${short(r.oosHighBudgetKes)})`, r.oosHigh, r.oosHighCount),
    tsection(`OUT OF STOCK, SLOW MOVERS (${r.oosLowCount} · ${cur} ${short(r.oosLowBudgetKes)})`, r.oosLow, r.oosLowCount),
    tsection(`OTHER REORDERS (${r.othersCount} · ${cur} ${short(r.othersBudgetKes)})`, r.others, r.othersCount),
    `\nTOTAL REORDER BUDGET: ${cur} ${short(r.totalBudgetKes)} across ${r.totalOrderLines} lines`,
  ].join("\n");

  return { subject, html, text };
}
