import { Redis } from "ioredis";
import {
  devAuthorizeSocket,
  prismaSessionStore,
  sessionAuthorizeSocket,
  type AuthorizeSocket,
} from "./auth";
import { startGateway } from "./gateway";

/**
 * Entrypoint. Env:
 *   PORT                  — listen port (default 8081)
 *   REDIS_URL             — pub/sub source (default redis://localhost:6380)
 *   SERVICE_DATABASE_URL  — session/membership lookups (via @wezesha/db)
 *   WS_DEV_TOKEN          — non-production only: also accept the dev stub's
 *                           `{secret}:{tenantId}` tokens alongside real sessions
 */
async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8081);
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6380";

  const sessionAuth = sessionAuthorizeSocket(prismaSessionStore());
  const devSecret =
    process.env.NODE_ENV === "production" ? undefined : process.env.WS_DEV_TOKEN;
  const devAuth = devSecret ? devAuthorizeSocket(devSecret) : null;
  const authorize: AuthorizeSocket = devAuth
    ? async (token) => (await devAuth(token)) ?? sessionAuth(token)
    : sessionAuth;

  const subscriber = new Redis(redisUrl);
  const gateway = await startGateway({
    port,
    subscriber,
    authorize,
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
