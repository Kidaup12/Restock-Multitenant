import { Redis } from "ioredis";
import { captureError, flushObservability, initObservability } from "@wezesha/observability";
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
 *   SENTRY_DSN            — error tracking; unset = tracking disabled (no-op)
 */
async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8081);
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6380";

  await initObservability("ws-gateway");
  // A crashed gateway drops every live socket — report before exiting so the
  // tracker sees why. Exit stays non-zero; the platform restart policy is
  // still the supervisor.
  const fatal = (origin: string) => (err: unknown) => {
    console.error(`ws-gateway: ${origin}`, err);
    captureError(err, { origin });
    void flushObservability(2000).finally(() => process.exit(1));
  };
  process.on("uncaughtException", fatal("uncaughtException"));
  process.on("unhandledRejection", fatal("unhandledRejection"));

  const sessionAuth = sessionAuthorizeSocket(prismaSessionStore());
  const devSecret =
    process.env.NODE_ENV === "production" ? undefined : process.env.WS_DEV_TOKEN;
  const devAuth = devSecret ? devAuthorizeSocket(devSecret) : null;
  // Dev tokens carry their tenant inline; only session auth consults the
  // connection's requested workspace.
  const authorize: AuthorizeSocket = devAuth
    ? async (token, workspace) => (await devAuth(token)) ?? sessionAuth(token, workspace)
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
