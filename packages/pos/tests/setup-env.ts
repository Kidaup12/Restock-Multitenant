// The ingest integration suite needs the database URLs. Reuse the db package's
// local .env so one docker compose + one .env serves every workspace's tests;
// the pure suites don't touch it.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const dbEnv = fileURLToPath(new URL("../../db/.env", import.meta.url));
if (existsSync(dbEnv)) config({ path: dbEnv });
