import { Redis } from "ioredis";
import { devAuthorizeSocket } from "./auth";
import { startGateway } from "./gateway";

/**
 * Entrypoint. Env:
 *   PORT          — listen port (default 8081)
 *   REDIS_URL     — pub/sub source (default redis://localhost:6380)
 *   WS_DEV_TOKEN  — dev auth shared secret; unset → all connections rejected
 */
async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8081);
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6380";

  const subscriber = new Redis(redisUrl);
  const gateway = await startGateway({
    port,
    subscriber,
    authorize: devAuthorizeSocket(process.env.WS_DEV_TOKEN),
  });
  console.log(`ws-gateway listening on :${gateway.port}`);

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`ws-gateway: ${signal} received, shutting down`);
    void gateway
      .close()
      .then(() => subscriber.quit())
      .then(
        () => process.exit(0),
        (err) => {
          console.error("ws-gateway: shutdown error", err);
          process.exit(1);
        }
      );
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("ws-gateway: fatal", err);
  process.exit(1);
});
