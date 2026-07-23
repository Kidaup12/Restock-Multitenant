// The shopify-sync suite needs the database URLs. Reuse the db package's local
// .env so one docker compose + one .env serves every workspace's tests; when it
// is absent the db-backed suite skips itself.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const dbEnv = fileURLToPath(new URL("../../../packages/db/.env", import.meta.url));
if (existsSync(dbEnv)) config({ path: dbEnv });
