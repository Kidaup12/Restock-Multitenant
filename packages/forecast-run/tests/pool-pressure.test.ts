import { describe, expect, it } from "vitest";

/**
 * The nightly run against a one-connection pool — the shape the deployed worker
 * runs in (`connection_limit=1` on the worker's DATABASE_URL). Every tenant-scoped
 * operation opens its own transaction, so a batch of reads issued together asks
 * the pool for one connection per read: the first takes it, the rest queue, and
 * `pool_timeout` kills whichever is still waiting. That is how the production run
 * died every night from 4 August — P2024 on the eighth read of a ten-way batch.
 *
 * One slow read is enough to starve everything behind it, so the test holds
 * `OwnerPrior` under an exclusive lock while the run reads it. Locally the reads
 * are fast enough to drain the queue inside any timeout; against a pooler, with a
 * round-trip per statement, they are not. The lock reproduces that without
 * depending on machine speed or dataset size.
 *
 * The squeeze has to land before `@wezesha/db` evaluates its client, hence the
 * dynamic imports.
 */

const runnable = /localhost|127\.0\.0\.1/.test(process.env.SERVICE_DATABASE_URL ?? "");

const LOCK_HELD_MS = 5_000;
const POOL_TIMEOUT_SECONDS = 2;

/** One connection, and an acquire wait shorter than the lock is held — so a read
 *  left queueing behind the slow one fails instead of quietly succeeding. */
function squeezePool(url: string): string {
  const squeezed = new URL(url);
  squeezed.searchParams.set("connection_limit", "1");
  squeezed.searchParams.set("pool_timeout", String(POOL_TIMEOUT_SECONDS));
  return squeezed.toString();
}

describe.skipIf(!runnable)("nightly run under a one-connection pool", () => {
  it("completes while a read it makes is slow", async () => {
    process.env.DATABASE_URL = squeezePool(process.env.DATABASE_URL ?? "");

    const { seedDev } = await import("../../db/scripts/seed-dev");
    const { prismaService } = await import("@wezesha/db");
    const { runForecast } = await import("../src/run");

    delete process.env.REDIS_URL; // publish degrades to a no-op
    const { tenantId } = await seedDev();

    // Held on the service pool, so it competes for the table and not for the
    // app pool's single connection.
    const lockHeld = prismaService.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('LOCK TABLE "OwnerPrior" IN ACCESS EXCLUSIVE MODE');
        await tx.$executeRawUnsafe(`SELECT pg_sleep(${LOCK_HELD_MS / 1000})`);
      },
      { timeout: LOCK_HELD_MS * 4 }
    );
    await new Promise((resolve) => setTimeout(resolve, 250)); // let the lock land

    const result = await runForecast(tenantId);
    await lockHeld;

    expect(result.created).toBeGreaterThan(0);
    const written = await prismaService.prediction.count({
      where: { tenantId, forecastRunId: result.forecastRunId },
    });
    expect(written).toBe(result.created);
  });
});
