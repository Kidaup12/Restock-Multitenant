import { Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { BUYABLE_PRODUCT_WHERE, CUSTOMER_TENANTS_WHERE, prismaService, type Prisma } from "@wezesha/db";
import { isDeadStock, recommendFor, shelfDaysSince, type Recommendation, type RecommendationProduct } from "@wezesha/forecast";
import { publishEvent } from "@wezesha/realtime";
import { latestForecastRunId } from "./owner-report";
import { wordRecommendations, type WordingItem } from "./recommendation-wording";

/**
 * Nightly stock recommendations: for each workspace, decide what to do about
 * dead and over-stocked products (rules in @wezesha/forecast recommendations.ts),
 * keep one StockRecommendation row per product and action up to date, word the
 * biggest new ones with Claude, and ring the bell once when there are new ones.
 *
 * Same fan-out shape as the cost-moved cron. Queries run on prismaService with an
 * explicit tenantId — the cron runs with no session.
 *
 * Inputs are the cheap, already-computed ones, so this adds little database
 * egress: product rows, the latest forecast run (its run rate and planned
 * quantity), a last-sale groupBy and an empty-shelf groupBy.
 */

export const RECOMMENDATION_CRON_QUEUE = "recommendation-crons";
export const RECOMMENDATION_SCHEDULER = "stock-recommendations";
/** 06:30 worker-local — after the overnight sync, 05:00 cost check and 06:07 forecast. */
export const RECOMMENDATION_PATTERN = "30 6 * * *";
export const RECOMMENDATION_DISPATCH_JOB = "recommendations-dispatch";
export const RECOMMENDATION_TENANT_JOB = "recommendations-tenant";

export const NOTIFICATION_KIND = "stock_recommendations";
const DEFAULT_DEAD_STOCK_DAYS = 90;
/** Most the AI wording may cost one workspace in a calendar month (USD). */
export const DEFAULT_AI_MONTHLY_CAP_USD = 5;

function aiCapUsd(): number {
  const v = Number(process.env.AI_MONTHLY_CAP_USD);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_AI_MONTHLY_CAP_USD;
}

/** What this workspace has left to spend on AI wording this month, and how to
 *  record a call against it. */
async function aiBudget(tenantId: string, now: Date) {
  const month = now.toISOString().slice(0, 7);
  const row = await prismaService.aiUsage.findUnique({
    where: { tenantId_month: { tenantId, month } },
    select: { costUsd: true },
  });
  return {
    remainingUsd: Math.max(0, aiCapUsd() - (row?.costUsd ?? 0)),
    onUsage: async (u: { costUsd: number; inputTokens: number; outputTokens: number }) => {
      await prismaService.aiUsage.upsert({
        where: { tenantId_month: { tenantId, month } },
        create: { tenantId, month, costUsd: u.costUsd, inputTokens: u.inputTokens, outputTokens: u.outputTokens, calls: 1 },
        update: {
          costUsd: { increment: u.costUsd },
          inputTokens: { increment: u.inputTokens },
          outputTokens: { increment: u.outputTokens },
          calls: { increment: 1 },
        },
      });
    },
  };
}
const DAY_MS = 86_400_000;

export type RecommendationCronJobData = { tenantId?: string };
export type RecommendationCronQueue = Queue<RecommendationCronJobData>;

export function createRecommendationCronQueue(connection: Redis): RecommendationCronQueue {
  return new Queue<RecommendationCronJobData>(RECOMMENDATION_CRON_QUEUE, { connection });
}

export async function registerRecommendationCronSchedules(queue: RecommendationCronQueue): Promise<void> {
  await queue.upsertJobScheduler(
    RECOMMENDATION_SCHEDULER,
    { pattern: RECOMMENDATION_PATTERN },
    { name: RECOMMENDATION_DISPATCH_JOB },
  );
}

export async function dispatchRecommendations(queue: RecommendationCronQueue): Promise<number> {
  // eslint-disable-next-line tenant-safety/require-tenant-scope -- fan-out dispatch: enumerating every customer workspace is the job, and the per-tenant work it queues is scoped.
  const tenants = await prismaService.tenant.findMany({ where: CUSTOMER_TENANTS_WHERE, select: { id: true } });
  if (tenants.length > 0) {
    await queue.addBulk(tenants.map((t) => ({ name: RECOMMENDATION_TENANT_JOB, data: { tenantId: t.id } })));
  }
  return tenants.length;
}

/** Gather the facts the rules need, for every buyable product. */
export async function recommendationInputs(
  tenantId: string,
  now: Date = new Date()
): Promise<{ products: RecommendationProduct[]; windowDays: number }> {
  const config = await prismaService.tenantConfig.findFirst({ where: { tenantId }, select: { deadStockWindowDays: true } });
  const windowDays = Math.min(365, Math.max(30, config?.deadStockWindowDays ?? DEFAULT_DEAD_STOCK_DAYS));
  const cutoff = new Date(now.getTime() - windowDays * DAY_MS);
  const runId = await latestForecastRunId(tenantId);

  const [products, lastSales, lastEmpty, predictions, overrides] = await Promise.all([
    prismaService.product.findMany({
      where: { tenantId, ...BUYABLE_PRODUCT_WHERE },
      select: { id: true, title: true, abcCategory: true, customCategory: true, currentStock: true, costKes: true, priceKes: true, shopifyCreatedAt: true, receivedAt: true },
    }),
    prismaService.salesHistory.groupBy({ by: ["productId"], where: { tenantId, quantity: { gt: 0 } }, _max: { date: true } }),
    prismaService.inventorySnapshot.groupBy({
      by: ["productId"],
      where: { tenantId, date: { gte: cutoff, lt: now }, onHand: { lte: 0 } },
      _max: { date: true },
    }),
    runId
      ? prismaService.prediction.findMany({
          where: { tenantId, forecastRunId: runId },
          select: { productId: true, layer1Forecast30d: true, recommendedQty: true },
        })
      : Promise.resolve([]),
    prismaService.productPlanOverride.findMany({ where: { tenantId }, select: { productId: true, qty: true } }),
  ]);

  const lastSale = new Map(lastSales.map((s) => [s.productId, s._max.date]));
  const emptyDay = new Map(lastEmpty.map((s) => [s.productId, s._max.date]));
  const prediction = new Map(predictions.map((p) => [p.productId, p]));
  const override = new Map(overrides.map((o) => [o.productId, o.qty]));

  return {
    windowDays,
    products: products.map((p) => {
      const sold = lastSale.get(p.id) ?? null;
      const empty = emptyDay.get(p.id) ?? null;
      const pred = prediction.get(p.id);
      const planned = override.get(p.id) ?? Math.round(pred?.recommendedQty ?? 0);
      return {
        productId: p.id,
        title: p.title,
        abc: p.abcCategory,
        category: p.customCategory,
        onHand: p.currentStock,
        costKes: p.costKes,
        priceKes: p.priceKes,
        // The run's own rate — what Stock shows as Sells/day.
        runRate: (pred?.layer1Forecast30d ?? 0) / 30,
        dead: isDeadStock({
          currentStock: p.currentStock,
          lastSaleAt: sold,
          firstSeenAt: p.shopifyCreatedAt ?? p.receivedAt,
          shelfDays: empty ? shelfDaysSince(empty, windowDays, now) : undefined,
          cutoff,
          asOf: now,
        }),
        daysSinceSale: sold ? Math.floor((now.getTime() - sold.getTime()) / DAY_MS) : null,
        plannedQty: Math.max(0, planned),
      };
    }),
  };
}

export type RecommendationRunResult = { open: number; opened: number; resolved: number; worded: number };

/**
 * Write the rules' verdict for one tenant. Existing rows update in place: an open
 * row stays open; a done/dismissed row stays quiet until its snooze ends, then
 * reopens if it still applies; an open row that no longer applies is resolved.
 */
export async function runTenantRecommendations(
  tenantId: string,
  publisher: Redis | null = null,
  now: Date = new Date(),
  word: typeof wordRecommendations = wordRecommendations
): Promise<RecommendationRunResult> {
  const { products, windowDays } = await recommendationInputs(tenantId, now);
  const recs = recommendFor(products, { windowDays });
  const productById = new Map(products.map((p) => [p.productId, p]));
  const key = (r: { productId: string; action: string }) => `${r.productId}|${r.action}`;

  const existing = await prismaService.stockRecommendation.findMany({
    where: { tenantId },
    select: { id: true, productId: true, action: true, status: true, snoozedUntil: true, reason: true, aiReason: true },
  });
  const byKey = new Map(existing.map((e) => [key(e), e]));
  const live = new Set(recs.map(key));

  let opened = 0;
  const needsWording: Recommendation[] = [];
  for (const r of recs) {
    const prior = byKey.get(key(r));
    const data = {
      payload: r.payload as Prisma.InputJsonValue,
      reason: r.reason,
      cashKes: r.cashKes,
      idleUnits: r.idleUnits,
    };
    if (!prior) {
      await prismaService.stockRecommendation.create({ data: { tenantId, productId: r.productId, action: r.action, status: "open", ...data } });
      opened++;
      needsWording.push(r);
      continue;
    }
    const quiet = (prior.status === "done" || prior.status === "dismissed") && prior.snoozedUntil != null && prior.snoozedUntil > now;
    const reopen = prior.status !== "open" && !quiet;
    // New numbers mean the old wording is stale — clear it and word it again.
    const changed = prior.reason !== r.reason;
    await prismaService.stockRecommendation.updateMany({
      where: { id: prior.id, tenantId },
      data: {
        ...data,
        ...(reopen ? { status: "open", resolvedAt: null, snoozedUntil: null } : {}),
        ...(changed ? { aiReason: null, aiIdea: null } : {}),
      },
    });
    if (reopen) opened++;
    if ((reopen || prior.status === "open") && (changed || prior.aiReason == null)) needsWording.push(r);
  }

  const stale = existing.filter((e) => e.status === "open" && !live.has(key(e)));
  if (stale.length > 0) {
    await prismaService.stockRecommendation.updateMany({
      where: { tenantId, id: { in: stale.map((e) => e.id) } },
      data: { status: "resolved", resolvedAt: now },
    });
  }

  // Biggest first — recs is already ranked by cash.
  const items: WordingItem[] = needsWording.map((r) => ({
    key: key(r),
    title: productById.get(r.productId)?.title ?? "",
    category: productById.get(r.productId)?.category ?? null,
    action: r.action,
    reason: r.reason,
    numbers: r.payload,
  }));
  const wording = items.length > 0 ? await word(items, await aiBudget(tenantId, now)) : new Map();
  for (const [k, w] of wording) {
    const [productId, action] = k.split("|");
    await prismaService.stockRecommendation.updateMany({
      where: { tenantId, productId, action },
      data: { aiReason: w.reason, aiIdea: w.idea },
    });
  }

  const open = recs.filter((r) => {
    const prior = byKey.get(key(r));
    return !prior || prior.status === "open" || !((prior.status === "done" || prior.status === "dismissed") && prior.snoozedUntil != null && prior.snoozedUntil > now);
  }).length;

  if (opened > 0) {
    // A count only — no cash figure, so the bell is safe for members who can't see costs.
    const title = opened === 1 ? "1 new stock recommendation" : `${opened} new stock recommendations`;
    await prismaService.notification.create({
      data: {
        tenantId,
        kind: NOTIFICATION_KIND,
        title,
        body: "Stock that isn't selling, and what to do about it — discounts, bundles and reorders to skip.",
        href: "/recommendations",
      },
    });
    if (publisher) {
      await publishEvent(publisher, { type: "notification.new", data: { tenantId, kind: NOTIFICATION_KIND, title } }).catch(() => {});
    }
  }

  return { open, opened, resolved: stale.length, worded: wording.size };
}

export interface RecommendationCronWorkerOptions {
  connection: Redis;
  queue: RecommendationCronQueue;
  publisher?: Redis;
}

export function createRecommendationCronWorker(options: RecommendationCronWorkerOptions): Worker<RecommendationCronJobData> {
  return new Worker<RecommendationCronJobData>(
    RECOMMENDATION_CRON_QUEUE,
    async (job: Job<RecommendationCronJobData>) => {
      if (job.name === RECOMMENDATION_DISPATCH_JOB) {
        await dispatchRecommendations(options.queue);
        return;
      }
      if (job.name === RECOMMENDATION_TENANT_JOB && job.data.tenantId) {
        const result = await runTenantRecommendations(job.data.tenantId, options.publisher ?? null);
        console.log(`worker: recommendations for ${job.data.tenantId}`, result);
      }
    },
    { connection: options.connection },
  );
}
