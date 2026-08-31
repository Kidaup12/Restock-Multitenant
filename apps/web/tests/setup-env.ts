// The auth flow suite hits the local database — reuse the db package's .env so
// one docker compose + one .env serves every workspace's tests. When it is
// absent (or not local) the suite skips itself locally (in CI,
// tests/require-infra.ts turns that skip into a failure).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const dbEnv = fileURLToPath(new URL("../../../packages/db/.env", import.meta.url));
if (existsSync(dbEnv)) config({ path: dbEnv });

process.env.BETTER_AUTH_SECRET ??= "auth-flow-test-secret";
process.env.BETTER_AUTH_URL ??= "http://auth-flow.test";
// The Shopify and QuickBooks callbacks build their redirects from configured
// origins rather than the request, so both throw when this is unset. That is
// deliberate in production; the suite has to supply one.
process.env.SHOPIFY_APP_URL ??= "http://auth-flow.test";

/**
 * Put the suite's queue state on its own Redis database.
 *
 * The queue has one fixed name, so a dev worker pointed at the same Redis
 * competes with the tests for it: it consumes a just-enqueued job before the
 * assertion reads it, and "expected a job, got undefined" or "expected
 * enqueued: false, got true" looks exactly like a bug in the code under test.
 * A logical database is enough — the worker never selects one, so it stays on
 * 0 and cannot see these keys. (Pub/sub is not database-scoped, so the realtime
 * suites are unaffected either way.)
 */
const TEST_REDIS_DB = 15;
if (process.env.REDIS_URL) {
  const url = new URL(process.env.REDIS_URL);
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = `/${TEST_REDIS_DB}`;
    process.env.REDIS_URL = url.toString();
  }
}

// Same rule as the globalSetup, derived rather than passed: these run in
// separate processes. A no-op in CI and when no database is configured.
import { redirectToTestDatabase } from "../../../scripts/test-database";
redirectToTestDatabase();
