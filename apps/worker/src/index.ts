import { Redis } from "ioredis";
import { createSyncWorker } from "./worker";

/**
 * Entrypoint. Env:
 *   REDIS_URL             — queues + event publishing (default redis://localhost:6380)
 *   DATABASE_URL          — RLS-enforced Prisma connection (client construction)
 *   SERVICE_DATABASE_URL  — BYPASSRLS connection: the sync's writes
 *   TOKEN_ENCRYPTION_KEY  — decrypts stored Shopify tokens (32 bytes, base64)
 *   SHOPIFY_APP_URL       — public web origin; registers webhook callbacks when set
 */
async function main(): Promise<void> {
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6380";

  // BullMQ workers block on BRPOPLPUSH — retries must not cap out mid-wait.
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const publisher = new Redis(redisUrl);

  const worker = createSyncWorker({ connection, publisher });
  worker.on("completed", (job) => console.log(`worker: ${job.id} completed`));
  worker.on("failed", (job, err) => console.error(`worker: ${job?.id} failed`, err));
  console.log("worker: listening on queue \"sync\"");

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`worker: ${signal} received, shutting down`);
    void worker
      .close() // waits for the in-flight job before releasing it
      .then(() => Promise.all([connection.quit(), publisher.quit()]))
      .then(
        () => process.exit(0),
        (err) => {
          console.error("worker: shutdown error", err);
          process.exit(1);
        }
      );
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("worker: fatal", err);
  process.exit(1);
});
