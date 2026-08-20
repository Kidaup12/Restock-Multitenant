import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { Client } from "pg";
import { databaseOf, redirectToTestDatabase, withDatabase } from "./test-database";

/**
 * Create and migrate the suites' own database, once per run, before any test
 * file is imported.
 *
 * Runs in the globalSetup process. `redirectToTestDatabase()` is called here AND in
 * each workspace's setup file, which is a different process — both derive the
 * same name from the same rule rather than passing one between them.
 *
 * `CREATE DATABASE` cannot run inside a transaction and cannot be parameterised,
 * so the name is validated rather than escaped: it is derived from a URL we
 * control, and anything outside a conservative character set is refused rather
 * than interpolated.
 */

const SAFE_NAME = /^[A-Za-z0-9_]+$/;

/** The db package's local .env, the one source every workspace's tests read. */
function loadLocalEnv(): void {
  const envPath = fileURLToPath(new URL("../packages/db/.env", import.meta.url));
  if (existsSync(envPath)) config({ path: envPath });
}

export async function ensureTestDatabase(): Promise<void> {
  // globalSetup runs in its own process and does not get the setup files' dotenv
  // load, so without this the URLs are only present when a developer happens to
  // have exported them, and the redirect would silently do nothing.
  loadLocalEnv();

  const database = redirectToTestDatabase();
  if (!database) return; // CI, or nothing configured

  if (!SAFE_NAME.test(database)) {
    throw new Error(`Refusing to create a database named ${JSON.stringify(database)}`);
  }

  // The owner role, which is the one allowed to create databases and run
  // migrations. DATABASE_URL's role is the restricted one RLS is enforced on.
  const owner = process.env.DIRECT_URL;
  if (!owner) throw new Error("DIRECT_URL is required to prepare the test database");

  // Connect to the maintenance database to ask whether ours exists — you cannot
  // create a database from a connection to the one being created.
  const admin = new Client({ connectionString: withDatabase(owner, "postgres") });
  await admin.connect();
  try {
    const { rowCount } = await admin.query("select 1 from pg_database where datname = $1", [
      database,
    ]);
    if (rowCount === 0) {
      console.log(`[tests] creating ${database}`);
      await admin.query(`CREATE DATABASE "${database}"`);
    }
  } finally {
    await admin.end();
  }

  // Idempotent, and the only thing that keeps the schema in step with the
  // developer's own database. The env is passed explicitly: a bare
  // `migrate deploy` reads whatever .env Prisma finds, which is how a migration
  // meant for one database has been applied to another before now.
  // Prisma's own JS entry under this node, rather than the `npx` shim: a .cmd
  // cannot be spawned without a shell on Windows (EINVAL), and passing args
  // through a shell concatenates them unescaped. No shim, no shell, same binary
  // on every platform.
  const prismaCli = createRequire(import.meta.url).resolve("prisma/build/index.js");
  execFileSync(process.execPath, [prismaCli, "migrate", "deploy", "--schema", "prisma/schema.prisma"], {
    cwd: fileURLToPath(new URL("../packages/db", import.meta.url)),
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, DIRECT_URL: process.env.DIRECT_URL },
    stdio: "pipe",
  });
}

/** Name of the database the suites will use — for messages only. */
export const testDatabaseLabel = (): string =>
  process.env.DATABASE_URL ? databaseOf(process.env.DATABASE_URL) : "(unset)";
