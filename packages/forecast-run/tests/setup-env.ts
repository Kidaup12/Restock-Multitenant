// Reuse the db package's local .env so one docker compose + one .env serves
// every workspace's tests; when it is absent the db-backed suites skip locally
// (in CI, tests/require-infra.ts turns that skip into a failure).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const dbEnv = fileURLToPath(new URL("../../db/.env", import.meta.url));
if (existsSync(dbEnv)) config({ path: dbEnv });

// Same rule as the globalSetup, derived rather than passed: these run in
// separate processes. A no-op in CI and when no database is configured.
import { redirectToTestDatabase } from "../../../scripts/test-database";
redirectToTestDatabase();
