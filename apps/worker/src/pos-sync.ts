import { UnrecoverableError, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { prismaService } from "@wezesha/db";
import { fetchPosFeed, ingestPosSales, type PosSaleInput } from "@wezesha/pos";
import { publishEvent } from "@wezesha/realtime";
import type { SyncJobData } from "@wezesha/queue";

/**
 * Per-tenant POS sync (source "pos"): pull the tenant's physical-shop sales feed
 * and hand the window to the shared ingest. Reuses the queue's no-overlap jobId
 * so one tenant never has two POS pulls in flight.
 *
 * The live feed is an authenticated per-tenant endpoint (Dellwest et al.) we
 * can't reach from dev/CI, so the fetch is the one seam: `loadFeed` is
 * injectable and defaults to a bearer-authed GET of TenantConfig.posFeedUrl. The
 * ingest itself runs on a plain payload, identical to the POST-payload path
 * (POST /api/pos/ingest), so tests exercise the real pipeline with no network.
 */

export type PosFeedLoader = (url: string, secret: string | undefined) => Promise<PosSaleInput[]>;

export interface PosSyncOptions {
  publisher: Redis;
  /** Injectable feed fetch for tests; defaults to the bearer-authed HTTP fetch. */
  loadFeed?: PosFeedLoader;
}

export function createPosSyncProcessor(options: PosSyncOptions) {
  const loadFeed: PosFeedLoader =
    options.loadFeed ?? ((url, secret) => fetchPosFeed(url, { secret }));

  return async (job: Job<SyncJobData>): Promise<void> => {
    const { tenantId } = job.data;
    const config = await prismaService.tenantConfig.findUnique({
      where: { tenantId },
      select: { posFeedUrl: true },
    });
    const feedUrl = config?.posFeedUrl?.trim();
    if (!feedUrl) {
      // POS feed not configured for this tenant — nothing to pull, not an error.
      await publishEvent(options.publisher, {
        type: "sync.done",
        data: { tenantId, source: "pos", ok: true },
      });
      return;
    }

    // A transient feed fetch/parse failure is retryable — let BullMQ back off.
    const sales = await loadFeed(feedUrl, process.env.POS_FEED_SECRET);

    const result = await ingestPosSales({ tenantId, sales });
    if (!result) throw new UnrecoverableError(`tenant ${tenantId} not found for POS ingest`);

    await publishEvent(options.publisher, {
      type: "pos.ingested",
      data: {
        tenantId,
        salesIngested: result.salesIngested,
        linesUnmatched: result.linesUnmatched,
      },
    });
    await publishEvent(options.publisher, {
      type: "sync.done",
      data: { tenantId, source: "pos", ok: true },
    });
  };
}

/**
 * Final-failure hook for POS syncs (wired to the worker's `failed` event): when
 * a pull is out of retries, persist a bell Notification and tell live clients the
 * sync ended. Retry-pending failures stay silent. Shopify failures are handled
 * by handleSyncFailure; this only fires for source "pos".
 */
export async function handlePosSyncFailure(
  job: Job<SyncJobData> | undefined,
  err: Error,
  publisher: Redis
): Promise<void> {
  if (!job || job.data.source !== "pos") return;
  const isFinal = err.name === "UnrecoverableError" || job.attemptsMade >= (job.opts.attempts ?? 1);
  if (!isFinal) return;

  const { tenantId } = job.data;
  try {
    await prismaService.notification.create({
      data: {
        tenantId,
        kind: "pos_sync_failed",
        title: "POS sales sync failed",
        body: `The last physical-shop sales pull did not finish: ${err.message.slice(0, 300)}`,
      },
    });
    await publishEvent(publisher, {
      type: "notification.new",
      data: { tenantId, kind: "pos_sync_failed", title: "POS sales sync failed" },
    });
  } catch (persistErr) {
    console.error(`worker: could not persist POS sync-failure notification for ${tenantId}`, persistErr);
  }
  await publishEvent(publisher, {
    type: "sync.done",
    data: { tenantId, source: "pos", ok: false },
  }).catch(() => {});
}
