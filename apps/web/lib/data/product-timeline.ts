import { prismaForTenantTx } from "@wezesha/db";

export type TimelineEvent = { id: string; at: string; label: string; qty: number | null; actor: string; detail: string };

/** Cost-free recorded history, bounded to a year, in one tenant-scoped transaction. */
export async function getProductTimeline(tenantId: string, productId: string, timezone: string, now = new Date()) {
  const since = new Date(+now - 365 * 86_400_000);
  const localDay = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const todayMarker = new Date(`${localDay}T00:00:00.000Z`);
  const daySince = new Date(+todayMarker - 364 * 86_400_000);
  const dayEnd = new Date(+todayMarker + 86_400_000);
  return prismaForTenantTx(tenantId, async tx => {
    const product = await tx.product.findFirst({ where: { id: productId }, select: { id: true, sku: true, title: true } });
    if (!product) return null;
    const [forecasts, orders, poLines, sales, emptyDays] = await Promise.all([
      tx.forecastRecommendation.findMany({ where: { productId, runDate: { gte: since, lte: now } }, orderBy: { runDate: "desc" }, take: 500, select: { id: true, runDate: true, recommendedQty: true, finalForecast30d: true, onHandAtRun: true } }),
      tx.order.findMany({ where: { productId, createdAt: { gte: since, lte: now } }, orderBy: { createdAt: "desc" }, take: 500, select: { id: true, createdAt: true, orderedQty: true, status: true, source: true } }),
      tx.purchaseOrderLine.findMany({ where: { productId, purchaseOrder: { deletedAt: null, createdAt: { lte: now } }, OR: [{ purchaseOrder: { createdAt: { gte: since } } }, { purchaseOrder: { sentAt: { gte: since, lte: now } } }, { receivedAt: { gte: since, lte: now } }] }, orderBy: { receivedAt: "desc" }, take: 500, select: { id: true, quantity: true, receivedQty: true, receivedAt: true, purchaseOrder: { select: { poNumber: true, createdAt: true, sentAt: true, status: true, createdByName: true } } } }),
      tx.salesHistory.findMany({ where: { productId, date: { gte: daySince, lt: dayEnd } }, orderBy: { date: "desc" }, take: 1500, select: { id: true, date: true, quantity: true, channel: true } }),
      tx.inventorySnapshot.findMany({ where: { productId, date: { gte: daySince, lt: dayEnd }, onHand: { lte: 0 } }, orderBy: { date: "desc" }, take: 366, select: { id: true, date: true, onHand: true } }),
    ]);
    const events: TimelineEvent[] = [];
    const add = (id: string, at: Date, label: string, qty: number | null, actor: string, detail = "", dayMarker = false) => {
      if (dayMarker ? at >= daySince && at < dayEnd : at >= since && at <= now) events.push({ id, at: at.toISOString(), label, qty, actor, detail });
    };
    for (const row of forecasts) add(`forecast-${row.id}`, row.runDate, "Restock recommendation", row.recommendedQty, "Forecast", `${row.finalForecast30d.toFixed(1)} units forecast over 30 days; ${row.onHandAtRun} on hand at the run`);
    for (const row of orders) add(`order-${row.id}`, row.createdAt, "Order queued", row.orderedQty, row.source === "app" ? "Shop team" : row.source, `Current status: ${row.status}`);
    for (const row of poLines) {
      const po = row.purchaseOrder;
      add(`po-${row.id}`, po.createdAt, `Purchase order ${po.poNumber}`, row.quantity, po.createdByName ?? "Shop team", `Current status: ${po.status}`);
      if (po.sentAt) add(`sent-${row.id}`, po.sentAt, `Sent ${po.poNumber}`, row.quantity, "Shop team");
      // Storage retains cumulative receiving + latest timestamp, not each delivery.
      if (row.receivedAt && row.receivedQty > 0) add(`received-${row.id}`, row.receivedAt, `Latest receipt · ${po.poNumber}`, row.receivedQty, "Receiving", "Cumulative units received on this line");
    }
    for (const row of sales) add(`sale-${row.id}`, row.date, "Daily sales", row.quantity, row.channel, "", true);
    for (const row of emptyDays) add(`empty-${row.id}`, row.date, "Empty-shelf snapshot", row.onHand, "Inventory snapshot", "", true);
    events.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
    return { product, since: since.toISOString(), events: events.slice(0, 1000), truncated: events.length > 1000 || forecasts.length === 500 || orders.length === 500 || poLines.length === 500 || sales.length === 1500 };
  }, { maxWait: 30_000, timeout: 30_000 });
}

export async function searchTimelineProducts(tenantId: string, query: string) {
  const q = query.trim().slice(0, 120);
  if (!q) return [];
  return prismaForTenantTx(tenantId, tx => tx.product.findMany({
    where: { OR: [{ title: { contains: q, mode: "insensitive" } }, { sku: { contains: q, mode: "insensitive" } }] },
    select: { id: true, title: true, sku: true }, orderBy: { title: "asc" }, take: 10,
  }));
}
