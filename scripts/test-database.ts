/**
 * Point the test suites at their own database.
 *
 * Thirty-odd suites call `seedDev()`, which rebuilds the demo tenant. Run
 * against the development database — which is what `npm run setup` builds and
 * what the dev server serves — that quietly destroys the state a tester was
 * given: `seedOrdersDemo` is deliberately not part of `seedDev`, so the two
 * delivered purchase orders, the seven queued rows and every supplier scorecard
 * simply vanish. Nothing on screen explains why, and the documented QA order
 * (security suites first) walks straight into it.
 *
 * So the suites get `<database>_test`, created and migrated by the globalSetup
 * before any file runs. The developer's own database is left alone.
 *
 * CI is deliberately exempt: its Postgres is a throwaway service container with
 * nothing to protect, it already migrates the database the workflow names, and
 * redirecting there would mean migrating twice for no gain.
 */

const TEST_SUFFIX = "_test";

/** The URL keys that must all point at the same database. */
const KEYS = ["DATABASE_URL", "SERVICE_DATABASE_URL", "DIRECT_URL"] as const;

/** Swap the database name in a Postgres URL, leaving role, host and params. */
export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** The database name in a Postgres URL. */
export function databaseOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}

/** What the suites should use: the explicit override, else `<db>_test`. */
export function testDatabaseName(url: string): string {
  const explicit = process.env.TEST_DATABASE_URL;
  if (explicit) return databaseOf(explicit);
  const base = databaseOf(url);
  return base.endsWith(TEST_SUFFIX) ? base : `${base}${TEST_SUFFIX}`;
}

/**
 * Rewrite every configured URL onto the test database. Returns the name in use,
 * or null when nothing was redirected (CI, or no URL configured at all).
 *
 * Idempotent: the suffix is only ever added once, so a setup file and a
 * globalSetup — which run in SEPARATE processes and both call this — derive the
 * same answer.
 */
export function redirectToTestDatabase(): string | null {
  if (process.env.CI) return null;
  const primary = process.env.DATABASE_URL;
  if (!primary) return null;

  const database = testDatabaseName(primary);
  for (const key of KEYS) {
    const url = process.env[key];
    if (url) process.env[key] = withDatabase(url, database);
  }
  return database;
}
