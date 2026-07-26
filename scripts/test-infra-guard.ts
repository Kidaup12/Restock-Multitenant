/**
 * Shared CI guard for the infrastructure-gated test suites.
 *
 * Most db/redis suites gate themselves with `describe.skipIf(!runnable)` so a
 * developer who hasn't run `docker compose up` still gets a useful pure-unit
 * run. In CI that same skip is a hole: the suite asserts nothing and the job
 * still reports green. This turns a missing (or non-local) URL into a hard
 * failure whenever `CI` is set; local behaviour is unchanged.
 *
 * Wired as a vitest `globalSetup` rather than a `setupFiles` entry: globalSetup
 * runs once, in the main process, before any test file — so suites that
 * `delete process.env.REDIS_URL` mid-run (forecast-cron, plan-data, po-flow …)
 * can't make a later file's guard fire spuriously.
 *
 * `packages/pos/tests/ingest.integration.test.ts` asserts the same thing inside
 * the suite; this is that reasoning applied to every workspace at once, without
 * touching individual test files.
 */

export type InfraDependency = "db" | "redis";

/** The suites accept only a local test database — mirror their predicate so
 *  "guard passes" means "no suite skips". */
const LOCAL_HOST = /localhost|127\.0\.0\.1/;

export function requireTestInfra(...required: InfraDependency[]): void {
  if (!process.env.CI) return;

  const missing: string[] = [];

  if (required.includes("db")) {
    for (const key of ["DATABASE_URL", "SERVICE_DATABASE_URL"]) {
      if (!LOCAL_HOST.test(process.env[key] ?? "")) {
        missing.push(`${key} — unset or not a local test database`);
      }
    }
  }

  if (required.includes("redis") && !process.env.REDIS_URL) {
    missing.push("REDIS_URL — unset");
  }

  if (missing.length === 0) return;

  throw new Error(
    [
      "Test infrastructure is missing, so the db/redis suites would skip themselves",
      "and this run would report green while asserting nothing:",
      ...missing.map((m) => `  - ${m}`),
      "Wire the service-container env into the job instead of letting the suites skip.",
    ].join("\n")
  );
}
