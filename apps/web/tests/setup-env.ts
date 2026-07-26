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
