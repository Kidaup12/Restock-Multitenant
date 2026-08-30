import type { OwnerReport, TrendRow, AttentionLine } from "./owner-report";

/**
 * Render an OwnerReport into a branded HTML email — a WEEK-BY-WEEK (or monthly)
 * health trend table (no buttons), a one-line "are we improving?" read, a short
 * bestsellers-stocked-out list, the restock buy-list, and any warehouse→branch
 * transfers. Plain-text fallback included.
 *
 * Ported from the reference app's lib/reports/report-email.ts. Brand strings are
 * parameterised (default "Wezesha Restock"); money uses the tenant's own
 * currency rather than a hardcoded KES.
 */

const DEFAULT_BRAND = "Wezesha Restock";

/** Short money: the tenant's currency code + a k/M-abbreviated amount. */
function money(cur: string, n: number): string {
  const a = Math.abs(n);
  const short =
    a >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
    : a >= 1_000 ? `${Math.round(n / 1_000)}k`
    : `${Math.round(n)}`;
  return `${cur} ${short}`;
}
const pct = (n: number | null) => (n == null ? "—" : `${n}%`);

const abcChip = (abc: AttentionLine["abc"]) => {
  const cls = abc ?? "C";
  const bg = cls === "A" ? "#db5586" : cls === "B" ? "#f2d0dd" : "#eee";
  const fg = cls === "A" ? "#fff" : cls === "B" ? "#a62f5c" : "#888";
  return `<span style="display:inline-block;width:18px;height:18px;line-height:18px;text-align:center;border-radius:5px;background:${bg};color:${fg};font-size:11px;font-weight:700">${cls}</span>`;
};

/** Neutral one-line summary of the latest period vs the one before — states the
 *  numbers, no "improving/worsening" verdict (owner reads the trend themselves). */
function improvementLine(trend: TrendRow[], unit: string): string {
  const withData = trend.filter((t) => t.stockoutPct != null);
  if (withData.length < 2) return `Bestseller stockout rate this ${unit}: ${withData[0]?.stockoutPct ?? "—"}%.`;
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

/** "What to restock next period" — the buy list + budget. */
function restockTable(cur: string, r: OwnerReport, unit: string): string {
  const budget = money(cur, r.restockBudgetKes);
  const header = `<h3 style="font-size:14px;margin:28px 0 4px">🛒 Restock next ${unit} — ${r.restockCount} item${r.restockCount === 1 ? "" : "s"} · budget ${budget}</h3>`;
  if (r.restock.length === 0) return `${header}<p style="color:#2f8a4c;font-size:13px;margin:4px 0 0">Nothing urgent to restock — you're well covered.</p>`;
  const rows = r.restock.map((l) => `<tr>
    <td style="padding:6px 4px;font-size:13px">${abcChip(l.abc)} ${l.title}</td>
    <td style="padding:6px 4px;font-size:13px;text-align:right;font-weight:600;white-space:nowrap">${l.qty}</td>
    <td style="padding:6px 4px;font-size:13px;text-align:right;white-space:nowrap;color:#666">${money(cur, l.costKes)}</td>
    <td style="padding:6px 4px;font-size:12px;text-align:right;white-space:nowrap;color:${l.daysLeft <= 0 ? "#c0392b" : "#888"}">${l.daysLeft}d left</td>
  </tr>`).join("");
  const more = r.restockCount > r.restock.length ? `<p style="color:#aaa;font-size:11px;margin:6px 0 0">Showing the top ${r.restock.length} by urgency · ${r.restockCount - r.restock.length} more in the Restock planner. <b>Budget ${budget} covers all ${r.restockCount} items.</b></p>` : "";
  return `${header}
  <p style="color:#666;font-size:12px;margin:2px 0 6px">Order these from your suppliers by next ${unit} — quantities already account for stock on hand and what's on the way.</p>
  <table style="width:100%;border-collapse:collapse;margin-top:4px">
    <tr><th style="text-align:left;font-size:10px;color:#aaa;text-transform:uppercase;padding:4px">Product</th><th style="text-align:right;font-size:10px;color:#aaa;text-transform:uppercase;padding:4px">Order</th><th style="text-align:right;font-size:10px;color:#aaa;text-transform:uppercase;padding:4px">Cost</th><th style="text-align:right;font-size:10px;color:#aaa;text-transform:uppercase;padding:4px">Runway</th></tr>
    ${rows}
  </table>${more}`;
}

/** "Distribute from the warehouse" — transfers to the branches. */
function transferTable(r: OwnerReport): string {
  if (r.transferCount === 0) return "";
  const header = `<h3 style="font-size:14px;margin:28px 0 4px">🚚 Distribute from ${r.transferFrom || "the warehouse"} — ${r.transferCount} transfer${r.transferCount === 1 ? "" : "s"}</h3>`;
  const rows = r.transfers.map((l) => `<tr>
    <td style="padding:6px 4px;font-size:13px">${abcChip(l.abc)} ${l.title}</td>
    <td style="padding:6px 4px;font-size:13px;text-align:right;font-weight:600;white-space:nowrap">${l.qty}</td>
    <td style="padding:6px 4px;font-size:12px;color:#666;text-align:right;white-space:nowrap">→ ${l.toBranch}</td>
  </tr>`).join("");
  const more = r.transferCount > r.transfers.length ? `<p style="color:#aaa;font-size:11px;margin:6px 0 0">Showing the top ${r.transfers.length} · ${r.transferCount - r.transfers.length} more in Distribution. Move stock you already own to the branches that need it (no new purchase).</p>` : `<p style="color:#aaa;font-size:11px;margin:6px 0 0">Move stock you already own to the branches that need it — no new purchase.</p>`;
  return `${header}
  <table style="width:100%;border-collapse:collapse;margin-top:4px">
    <tr><th style="text-align:left;font-size:10px;color:#aaa;text-transform:uppercase;padding:4px">Product</th><th style="text-align:right;font-size:10px;color:#aaa;text-transform:uppercase;padding:4px">Move</th><th style="text-align:right;font-size:10px;color:#aaa;text-transform:uppercase;padding:4px">To branch</th></tr>
    ${rows}
  </table>${more}`;
}

function attentionList(lines: AttentionLine[]): string {
  if (lines.length === 0) return `<p style="color:#2f8a4c;font-size:13px;margin:0">No bestsellers stocked out right now — nicely covered.</p>`;
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
  const subject = `${periodWord} report — ${r.tenantName} · ${r.latestLabel}`;

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

  <h3 style="font-size:14px;margin:28px 0 8px">🔴 Bestsellers stocked out now</h3>
  ${attentionList(r.needsAttention)}

  ${restockTable(cur, r, unit)}

  ${transferTable(r)}

  <hr style="border:none;border-top:1px solid #eee;margin:30px 0 16px"/>
  <p style="color:#bbb;font-size:11px;margin:0">Coming from ${brand} · you're receiving this as an owner/admin of ${r.tenantName}.</p>
</div>`;

  // Plain-text fallback — the same trend as an aligned table.
  const col = (s: string | number, w: number) => String(s).padEnd(w).slice(0, w);
  const head = `${col(unit === "week" ? "Week" : "Month", 9)} ${col("Sales", 10)} ${col("OutA", 5)} ${col("OutB", 5)} ${col("Out%", 6)} ${col("Dead", 14)} Missed`;
  const trendLines = r.trend.map((t) => `${col(t.label, 9)} ${col(money(cur, t.salesKes), 10)} ${col(t.stockoutA, 5)} ${col(t.stockoutB, 5)} ${col(pct(t.stockoutPct), 6)} ${col(t.deadCount + "·" + money(cur, t.deadValueKes), 14)} ${money(cur, t.missedRevenueKes)}`);
  const text = [
    `${periodWord} report — ${r.tenantName} · ${r.latestLabel}`,
    ``,
    improvementLine(r.trend, unit).replace(/<[^>]+>/g, ""),
    ``,
    `LAST ${r.trend.length} ${unit.toUpperCase()}S`,
    head,
    ...trendLines,
    ``,
    `BESTSELLERS STOCKED OUT NOW`,
    r.needsAttention.length
      ? r.needsAttention.map((l) => `  [${l.abc ?? "C"}] ${l.title} — ${l.onHand} on hand, ${l.enRoute > 0 ? `${l.enRoute} en route` : "nothing coming"}`).join("\n")
      : "  none — nicely covered.",
    ``,
    `RESTOCK NEXT ${unit.toUpperCase()} (order from suppliers) — ${r.restockCount} items · budget ${money(cur, r.restockBudgetKes)}`,
    r.restock.length
      ? r.restock.map((l) => `  [${l.abc ?? "C"}] ${l.title} — order ${l.qty} (${money(cur, l.costKes)}, ${l.daysLeft}d left)`).join("\n")
      : "  nothing urgent.",
    ``,
    ...(r.transferCount > 0
      ? [
          `DISTRIBUTE FROM ${r.transferFrom.toUpperCase()} — ${r.transferCount} transfers (move stock you own, no purchase)`,
          r.transfers.map((l) => `  [${l.abc ?? "C"}] ${l.title} — move ${l.qty} → ${l.toBranch}`).join("\n"),
          ``,
        ]
      : []),
    `Coming from ${brand}`,
  ].join("\n");

  return { subject, html, text };
}
