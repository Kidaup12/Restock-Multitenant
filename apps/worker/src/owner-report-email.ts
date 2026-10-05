import type { OwnerReport, TrendRow, AttentionLine } from "./owner-report";

/**
 * Render an OwnerReport into a branded HTML email: a WEEK-BY-WEEK (or monthly)
 * health trend table (no buttons), a one-line "are we improving?" read, a short
 * bestsellers-stocked-out list, the restock buy-list, and any warehouse-to-branch
 * transfers. Plain-text fallback included.
 *
 * Ported from the reference app's lib/reports/report-email.ts. Brand strings are
 * parameterised (default "Wezesha Restock"); money uses the tenant's own
 * currency rather than a hardcoded KES.
 */

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const DEFAULT_BRAND = "Wezesha Restock";

/** Short money: the tenant's currency code + a k/M-abbreviated amount. A null
 *  is a number the report never had the inputs to compute, and renders as a
 *  dash, never as a confident zero. */
function money(cur: string, n: number | null): string {
  if (n == null) return "-";
  const a = Math.abs(n);
  const short =
    a >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
    : a >= 1_000 ? `${Math.round(n / 1_000)}k`
    : `${Math.round(n)}`;
  return `${cur} ${short}`;
}
const pct = (n: number | null) => (n == null ? "-" : `${n}%`);

const abcChip = (abc: AttentionLine["abc"]) => {
  const cls = abc ?? "C";
  const bg = cls === "A" ? "#db5586" : cls === "B" ? "#f2d0dd" : "#eee";
  const fg = cls === "A" ? "#fff" : cls === "B" ? "#a62f5c" : "#888";
  return `<span style="display:inline-block;width:18px;height:18px;line-height:18px;text-align:center;border-radius:5px;background:${bg};color:${fg};font-size:11px;font-weight:700">${cls}</span>`;
};

/** Neutral one-line summary of the latest period vs the one before: states the
 *  numbers, no "improving/worsening" verdict (owner reads the trend themselves). */
function improvementLine(trend: TrendRow[], unit: string): string {
  const withData = trend.filter((t) => t.stockoutPct != null);
  // `${null}%` prints "—%", which reads as a measured zero-point-something. The
  // dash has to stand alone: this is the email's first line.
  if (withData.length < 2) return `Bestseller stockout rate this ${unit}: ${pct(withData[0]?.stockoutPct ?? null)}.`;
  const now = withData[0]!.stockoutPct!;
  const prev = withData[1]!.stockoutPct!;
  const colour = now > prev ? "#c0392b" : now < prev ? "#2f8a4c" : "#666";
  return `Bestseller stockout rate: <span style="color:${colour};font-weight:600">${now}%</span> this ${unit} (last ${unit}: ${prev}%).`;
}

function trendTable(cur: string, trend: TrendRow[], unit: string): string {
  const th = (t: string, right = true) => `<th style="text-align:${right ? "right" : "left"};font-size:10px;color:#aaa;text-transform:uppercase;letter-spacing:.3px;padding:6px 5px;border-bottom:2px solid #333">${t}</th>`;
  const td = (t: string, right = true, bold = false, colour = "#333") => `<td style="text-align:${right ? "right" : "left"};font-size:13px;padding:7px 5px;border-bottom:1px solid #eee;color:${colour}${bold ? ";font-weight:700" : ""}">${t}</td>`;
  const rows = trend.map((r, i) => {
    const flag = r.partial ? ` <span style="color:#b8791a;font-size:10px">partial</span>` : r.inferred ? ` <span style="color:#999;font-size:10px">est.</span>` : "";
    const soColour = r.stockoutPct == null ? "#999" : r.stockoutPct >= 15 ? "#c0392b" : r.stockoutPct <= 8 ? "#2f8a4c" : "#333";
    return `<tr${i === 0 ? ' style="background:#faf5f7"' : ""}>
      ${td(`<b>${r.label}</b>${flag}`, false)}
      ${td(money(cur, r.salesKes))}
      ${td(`${r.stockoutA}`, true, i === 0, r.stockoutA > 0 ? "#c0392b" : "#999")}
      ${td(`${r.stockoutB}`)}
      ${td(pct(r.stockoutPct), true, i === 0, soColour)}
      ${td(`${r.deadCount} · ${money(cur, r.deadValueKes)}`)}
      ${td(money(cur, r.missedRevenueKes))}
    </tr>`;
  }).join("");
  return `<table style="width:100%;border-collapse:collapse;margin-top:6px">
    <tr>${th(unit === "week" ? "Week" : "Month", false)}${th("Sales")}${th("Out A")}${th("Out B")}${th("Out %")}${th("Dead (#·" + cur + ")")}${th("Rev. missed")}</tr>
    ${rows}
  </table>
  <p style="color:#aaa;font-size:11px;margin:8px 0 0"><b>Out A / Out B</b> = Class-A / Class-B bestsellers that ran to zero · <b>Out %</b> = A/B stockout rate · <b>Dead</b> = held items with no sales + capital frozen · <b>Rev. missed</b> = est. sales lost while out of stock. Newest ${unit} highlighted.</p>`;
}

function restockSection(cur: string, title: string, hint: string, lines: OwnerReport["criticals"], emptyMsg: string, moreNote = ""): string {
  const header = `<h3 style="font-size:14px;margin:26px 0 4px">${title}</h3>`;
  if (lines.length === 0) return `${header}<p style="color:#2f8a4c;font-size:13px;margin:4px 0 0">${emptyMsg}</p>`;
  const rows = lines.map(l => `<tr>
    <td style="padding:6px 4px;font-size:13px">${abcChip(l.abc)} ${escapeHtml(l.title)}</td>
    <td style="padding:6px 4px;font-size:13px;text-align:right;font-weight:600;white-space:nowrap">${l.qty}</td>
    <td style="padding:6px 4px;font-size:13px;text-align:right;white-space:nowrap;color:#666">${money(cur, l.costKes)}</td>
    <td style="padding:6px 4px;font-size:12px;text-align:right;white-space:nowrap;color:#888">${l.runRate}/d</td>
    <td style="padding:6px 4px;font-size:12px;text-align:right;white-space:nowrap;color:#555">${l.onHand}</td>
    <td style="padding:6px 4px;font-size:12px;text-align:right;white-space:nowrap;color:${l.enRoute > 0 ? "#2a7ab0" : "#ccc"};font-weight:${l.enRoute > 0 ? "600" : "400"}">${l.enRoute > 0 ? l.enRoute : "-"}</td>
    <td style="padding:6px 4px;font-size:12px;text-align:right;white-space:nowrap;color:${l.daysLeft <= 0 ? "#c0392b" : "#888"}">${l.daysLeft <= 0 ? "out now" : `${l.daysLeft}d left`}</td>
  </tr>`).join("");
  return `${header}
  <p style="color:#666;font-size:12px;margin:2px 0 6px">${hint}</p>
  <table style="width:100%;border-collapse:collapse;margin-top:4px">
    <tr><th style="text-align:left;font-size:10px;color:#aaa;text-transform:uppercase;padding:4px">Product</th><th style="text-align:right;font-size:10px;color:#aaa;text-transform:uppercase;padding:4px">Order</th><th style="text-align:right;font-size:10px;color:#aaa;text-transform:uppercase;padding:4px">Cost</th><th style="text-align:right;font-size:10px;color:#aaa;text-transform:uppercase;padding:4px">Rate</th><th style="text-align:right;font-size:10px;color:#aaa;text-transform:uppercase;padding:4px">On hand</th><th style="text-align:right;font-size:10px;color:#aaa;text-transform:uppercase;padding:4px">En route</th><th style="text-align:right;font-size:10px;color:#aaa;text-transform:uppercase;padding:4px">Runway</th></tr>
    ${rows}
  </table>${moreNote ? `<p style="color:#aaa;font-size:11px;margin:6px 0 0">${moreNote}</p>` : ""}`;
}

/** Last period's best sellers: what actually earned, units and money. */
function topSellersTable(cur: string, r: OwnerReport): string {
  if (r.topSellers.length === 0) return "";
  const rows = r.topSellers.map(l => `<tr>
    <td style="padding:5px 4px;font-size:13px">${abcChip(l.abc)} ${escapeHtml(l.title)}</td>
    <td style="padding:5px 4px;font-size:13px;text-align:right;white-space:nowrap">${l.qty}u</td>
    <td style="padding:5px 4px;font-size:13px;text-align:right;font-weight:600;white-space:nowrap">${money(cur, l.revenueKes)}</td>
  </tr>`).join("");
  return `<h3 style="font-size:14px;margin:26px 0 4px">Best sellers, ${r.latestLabel}</h3>
  <p style="color:#666;font-size:12px;margin:2px 0 6px">What actually earned last ${r.granularity === "week" ? "week" : "month"}.</p>
  <table style="width:100%;border-collapse:collapse;margin-top:4px">
    <tr><th style="text-align:left;font-size:10px;color:#aaa;text-transform:uppercase;padding:4px">Product</th><th style="text-align:right;font-size:10px;color:#aaa;text-transform:uppercase;padding:4px">Sold</th><th style="text-align:right;font-size:10px;color:#aaa;text-transform:uppercase;padding:4px">Revenue</th></tr>
    ${rows}
  </table>`;
}

/** The four-part restock block: bestseller pulse → OOS → criticals → the rest. */
function restockTable(cur: string, r: OwnerReport): string {
  const budget = money(cur, r.restockBudgetKes);
  const b = r.bestsellers;
  const pulse = `<h3 style="font-size:14px;margin:28px 0 4px">Bestseller update</h3>
  <p style="font-size:13px;margin:2px 0 0">Of your <b>${b.total}</b> bestsellers (Class A): <b style="color:#2f8a4c">${b.healthy} healthy</b> · <b style="color:#b8860b">${b.low} running low</b> (≤7 days of cover) · <b style="color:#c0392b">${b.out} out</b> right now.</p>`;

  const sections = [
    pulse,
    topSellersTable(cur, r),
    restockSection(cur,
      `Completely out of stock: ${r.oosCount} item${r.oosCount === 1 ? "" : "s"} · ${money(cur, r.oosBudgetKes)}`,
      "Zero on the shelf right now. Every day out costs the full rate shown.",
      r.oos, "Nothing is fully out.",
      r.oosCount > r.oos.length ? `Showing the top ${r.oos.length} by class and rate · ${r.oosCount - r.oos.length} more in the Restock planner. ${money(cur, r.oosBudgetKes)} covers all ${r.oosCount}.` : ""),
    restockSection(cur,
      `Critical reorders (fast movers running low): ${r.criticalsCount} item${r.criticalsCount === 1 ? "" : "s"} · ${money(cur, r.criticalsBudgetKes)}`,
      "High run rate with a week or less of cover left. These die first if not ordered now.",
      r.criticals, "No fast mover is running low.",
      r.criticalsCount > r.criticals.length ? `Showing the top ${r.criticals.length} · ${r.criticalsCount - r.criticals.length} more in the Restock planner.` : ""),
    restockSection(cur,
      `Fast movers, order soon: ${r.upcomingCount} item${r.upcomingCount === 1 ? "" : "s"} · ${money(cur, r.upcomingBudgetKes)}`,
      "Selling fast with more than a week of cover. Order in your next cycle, before they turn critical.",
      r.upcoming, "No fast mover is waiting.",
      r.upcomingCount > r.upcoming.length ? `Showing the top ${r.upcoming.length} · ${r.upcomingCount - r.upcoming.length} more in the Restock planner.` : ""),
    restockSection(cur,
      `Slow and medium movers: ${r.othersCount} items · ${money(cur, r.othersBudgetKes)}`,
      "Lower run rates. Not urgent, but the planner says they've earned a top-up.",
      r.others, "Nothing else needs a reorder.",
      r.othersCount > r.others.length ? `Showing the top ${r.others.length} · ${r.othersCount - r.others.length} more in the Restock planner.` : ""),
  ].join("\n");

  return `${sections}
  <p style="font-size:13px;margin:14px 0 0;padding:10px 12px;background:#faf7ef;border-radius:8px"><b>Budget ${budget}</b> covers the full list, all ${r.restockCount} items, quantities already net of stock on hand and en route. Open the <b>Restock planner</b> for the rest.</p>`;
}

/** "Distribute from the warehouse" — transfers to the branches. */
function transferTable(r: OwnerReport): string {
  if (r.transferCount === 0) return "";
  const header = `<h3 style="font-size:14px;margin:28px 0 4px">Distribute from ${r.transferFrom || "the warehouse"} - ${r.transferCount} transfer${r.transferCount === 1 ? "" : "s"}</h3>`;
  const rows = r.transfers.map((l) => `<tr>
    <td style="padding:6px 4px;font-size:13px">${abcChip(l.abc)} ${l.title}</td>
    <td style="padding:6px 4px;font-size:13px;text-align:right;font-weight:600;white-space:nowrap">${l.qty}</td>
    <td style="padding:6px 4px;font-size:12px;color:#666;text-align:right;white-space:nowrap">→ ${l.toBranch}</td>
  </tr>`).join("");
  const more = r.transferCount > r.transfers.length ? `<p style="color:#aaa;font-size:11px;margin:6px 0 0">Showing the top ${r.transfers.length} · ${r.transferCount - r.transfers.length} more in Distribution. Move stock you already own to the branches that need it (no new purchase).</p>` : `<p style="color:#aaa;font-size:11px;margin:6px 0 0">Move stock you already own to the branches that need it, no new purchase.</p>`;
  return `${header}
  <table style="width:100%;border-collapse:collapse;margin-top:4px">
    <tr><th style="text-align:left;font-size:10px;color:#aaa;text-transform:uppercase;padding:4px">Product</th><th style="text-align:right;font-size:10px;color:#aaa;text-transform:uppercase;padding:4px">Move</th><th style="text-align:right;font-size:10px;color:#aaa;text-transform:uppercase;padding:4px">To branch</th></tr>
    ${rows}
  </table>${more}`;
}

function attentionList(lines: AttentionLine[]): string {
  if (lines.length === 0) return `<p style="color:#2f8a4c;font-size:13px;margin:0">No bestsellers stocked out right now - nicely covered.</p>`;
  const rows = lines.map((l) => `<tr>
    <td style="padding:6px 4px;font-size:13px">${abcChip(l.abc)} ${l.title}</td>
    <td style="padding:6px 4px;font-size:13px;text-align:right;font-weight:600;white-space:nowrap">${l.onHand} on hand</td>
    <td style="padding:6px 4px;font-size:12px;color:${l.enRoute > 0 ? "#2f8a4c" : "#c0392b"};text-align:right;white-space:nowrap">${l.enRoute > 0 ? `${l.enRoute} en route` : "nothing coming"}</td>
  </tr>`).join("");
  return `<table style="width:100%;border-collapse:collapse">${rows}</table>`;
}

export function renderReportEmail(
  r: OwnerReport,
  brand: string = DEFAULT_BRAND,
): { subject: string; html: string; text: string } {
  const unit = r.granularity === "week" ? "week" : "month";
  const periodWord = r.granularity === "week" ? "Weekly" : "Monthly";
  const cur = r.currency || "KES";
  const initial = brand.trim().charAt(0).toUpperCase() || "W";
  const subject = `${brand} ${periodWord} Report: ${r.tenantName} · ${r.latestLabel}`;

  const html = `<div style="font-family:sans-serif;max-width:640px;margin:0 auto;padding:32px 24px;color:#1a1a1a">
  <div style="margin-bottom:18px">
    <span style="display:inline-block;width:34px;height:34px;border-radius:9px;background:linear-gradient(135deg,#db5586,#a62f5c);color:#fff;font-weight:700;font-size:15px;text-align:center;line-height:34px">${initial}</span>
    <span style="margin-left:10px;font-weight:600;font-size:15px">${brand}</span>
  </div>
  <div style="font-size:11px;color:#aaa;text-transform:uppercase;letter-spacing:.5px">${periodWord} report · ${r.tenantName}</div>
  <h1 style="font-size:22px;font-weight:700;margin:2px 0 10px">How your shop is trending</h1>
  <p style="font-size:14px;line-height:1.5;margin:0 0 4px">${improvementLine(r.trend, unit)}</p>

  <h3 style="font-size:14px;margin:26px 0 4px">Last ${r.trend.length} ${unit}s</h3>
  ${trendTable(cur, r.trend, unit)}

  <h3 style="font-size:14px;margin:28px 0 8px">Bestsellers stocked out now</h3>
  ${attentionList(r.needsAttention)}

  ${restockTable(cur, r)}

  ${transferTable(r)}

  <hr style="border:none;border-top:1px solid #eee;margin:30px 0 16px"/>
  <p style="color:#bbb;font-size:11px;margin:0">Coming from ${brand} · you're receiving this as an owner/admin of ${r.tenantName}.</p>
</div>`;

  // Plain-text fallback: the same trend as an aligned table.
  const col = (s: string | number, w: number) => String(s).padEnd(w).slice(0, w);
  const head = `${col(unit === "week" ? "Week" : "Month", 9)} ${col("Sales", 10)} ${col("OutA", 5)} ${col("OutB", 5)} ${col("Out%", 6)} ${col("Dead", 14)} Missed`;
  const trendLines = r.trend.map((t) => `${col(t.label, 9)} ${col(money(cur, t.salesKes), 10)} ${col(t.stockoutA, 5)} ${col(t.stockoutB, 5)} ${col(pct(t.stockoutPct), 6)} ${col(t.deadCount + "·" + money(cur, t.deadValueKes), 14)} ${money(cur, t.missedRevenueKes)}`);
  const text = [
    `${periodWord} report - ${r.tenantName} · ${r.latestLabel}`,
    ``,
    improvementLine(r.trend, unit).replace(/<[^>]+>/g, ""),
    ``,
    `LAST ${r.trend.length} ${unit.toUpperCase()}S`,
    head,
    ...trendLines,
    ``,
    `BESTSELLERS STOCKED OUT NOW`,
    r.needsAttention.length
      ? r.needsAttention.map((l) => `  [${l.abc ?? "C"}] ${l.title} - ${l.onHand} on hand, ${l.enRoute > 0 ? `${l.enRoute} en route` : "nothing coming"}`).join("\n")
      : "  none - nicely covered.",
    ``,
    `RESTOCK NEXT ${unit.toUpperCase()} (order from suppliers) - ${r.restockCount} items · budget ${money(cur, r.restockBudgetKes)}`,
    `BESTSELLER UPDATE: ${r.bestsellers.healthy} healthy, ${r.bestsellers.low} low, ${r.bestsellers.out} out`,
    `BEST SELLERS, ${r.latestLabel}`,
    ...r.topSellers.map(l => `  ${l.title}: ${l.qty} units, ${money(cur, l.revenueKes)}`),
    ...([
      ["COMPLETELY OUT OF STOCK", r.oos, r.oosCount, r.oosBudgetKes],
      ["CRITICAL REORDERS", r.criticals, r.criticalsCount, r.criticalsBudgetKes],
      ["FAST MOVERS, ORDER SOON", r.upcoming, r.upcomingCount, r.upcomingBudgetKes],
      ["SLOW AND MEDIUM MOVERS", r.others, r.othersCount, r.othersBudgetKes],
    ] as const).flatMap(([title, lines, count, cost]) => [
      `${title}: ${count} items, ${money(cur, cost)}`,
      ...lines.map(l => `  [${l.abc ?? "C"}] ${l.title}: order ${l.qty}, ${money(cur, l.costKes)}, ${l.runRate}/day, ${l.onHand} on hand, ${l.enRoute} en route, ${l.daysLeft}d left`),
    ]),
    ``,
    ...(r.transferCount > 0
      ? [
          `DISTRIBUTE FROM ${r.transferFrom.toUpperCase()} - ${r.transferCount} transfers (move stock you own, no purchase)`,
          r.transfers.map((l) => `  [${l.abc ?? "C"}] ${l.title} - move ${l.qty} → ${l.toBranch}`).join("\n"),
          ``,
        ]
      : []),
    `Coming from ${brand}`,
  ].join("\n");

  return { subject, html, text };
}
