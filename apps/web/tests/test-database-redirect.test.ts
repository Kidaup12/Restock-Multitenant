import { afterEach, describe, expect, it } from "vitest";
import {
  databaseOf,
  testDatabaseName,
  redirectToTestDatabase,
  withDatabase,
} from "../../../scripts/test-database";

/**
 * The suites must not run against the development database.
 *
 * Thirty-odd of them call `seedDev()`, which rebuilds the demo tenant.
 * `seedOrdersDemo` is deliberately NOT part of it, so a rebuild silently drops
 * the two delivered purchase orders, the seven queued rows and every supplier
 * scorecard — and the documented QA order (security suites first) walks a tester
 * straight into it, with nothing on screen explaining where their data went.
 *
 * The redirect is derived, not passed: the globalSetup and each worker process
 * run separately and both call `redirectToTestDatabase()`, so the rule has to give the
 * same answer twice.
 */

const ORIGINAL = { ...process.env };

afterEach(() => {
  for (const key of ["DATABASE_URL", "SERVICE_DATABASE_URL", "DIRECT_URL", "TEST_DATABASE_URL", "CI"]) {
    if (ORIGINAL[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL[key];
  }
});

const local = (db: string, role = "wezesha_app") =>
  `postgresql://${role}:pw@localhost:5434/${db}?schema=public`;

function setUrls(db: string) {
  delete process.env.CI;
  delete process.env.TEST_DATABASE_URL;
  process.env.DATABASE_URL = local(db);
  process.env.SERVICE_DATABASE_URL = local(db, "wezesha_service");
  process.env.DIRECT_URL = local(db, "postgres");
}

describe("the suites' own database", () => {
  it("appends _test to the development database name", () => {
    expect(testDatabaseName(local("wezesha"))).toBe("wezesha_test");
  });

  it("is idempotent — two processes deriving it agree", () => {
    // globalSetup and the workers both call this; a second pass must not
    // produce wezesha_test_test.
    expect(testDatabaseName(local("wezesha_test"))).toBe("wezesha_test");
  });

  it("redirects every configured URL onto the same database", () => {
    setUrls("wezesha");
    expect(redirectToTestDatabase()).toBe("wezesha_test");
    for (const key of ["DATABASE_URL", "SERVICE_DATABASE_URL", "DIRECT_URL"] as const) {
      expect(databaseOf(process.env[key]!), key).toBe("wezesha_test");
    }
  });

  it("keeps the role, host, port and params of each URL", () => {
    setUrls("wezesha");
    redirectToTestDatabase();
    // The three roles are not interchangeable: DATABASE_URL's is the restricted
    // one RLS is enforced on, DIRECT_URL's is the owner. Swapping them is how a
    // battery goes green with RLS switched off.
    expect(process.env.DATABASE_URL).toContain("wezesha_app:");
    expect(process.env.SERVICE_DATABASE_URL).toContain("wezesha_service:");
    expect(process.env.DIRECT_URL).toContain("postgres:");
    expect(process.env.DATABASE_URL).toContain("localhost:5434");
    expect(process.env.DATABASE_URL).toContain("schema=public");
  });

  it("honours an explicit TEST_DATABASE_URL", () => {
    setUrls("wezesha");
    process.env.TEST_DATABASE_URL = local("somewhere_else");
    expect(redirectToTestDatabase()).toBe("somewhere_else");
    expect(databaseOf(process.env.DATABASE_URL!)).toBe("somewhere_else");
  });

  it("leaves CI alone", () => {
    setUrls("wezesha");
    process.env.CI = "true";
    expect(redirectToTestDatabase()).toBeNull();
    // The workflow's own throwaway container, already migrated by the job.
    expect(databaseOf(process.env.DATABASE_URL!)).toBe("wezesha");
  });

  it("does nothing when no database is configured", () => {
    delete process.env.CI;
    delete process.env.DATABASE_URL;
    expect(redirectToTestDatabase()).toBeNull();
  });

  it("swaps only the database in a URL", () => {
    expect(withDatabase("postgresql://u:p@host:5434/one?schema=public", "two")).toBe(
      "postgresql://u:p@host:5434/two?schema=public"
    );
  });
});
