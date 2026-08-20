// The ingest integration suite needs the database URLs. Reuse the db package's
// local .env so one docker compose + one .env serves every workspace's tests;
// the pure suites don't touch it. In CI, tests/require-infra.ts fails the run
// rather than let the integration suite go quiet.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const dbEnv = fileURLToPath(new URL("../../db/.env", import.meta.url));
if (existsSync(dbEnv)) config({ path: dbEnv });

// Same rule as the globalSetup, derived rather than passed: these run in
// separate processes. A no-op in CI and when no database is configured.
import { redirectToTestDatabase } from "../../../scripts/test-database";
redirectToTestDatabase();
