import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Census of the suite itself. Dropping `passWithNoTests` makes an empty glob
 * fail, but that only fires at zero — a rename or a botched merge that takes
 * half these files with it still exits green on whatever survives. The isolation
 * gate is the strongest claim this product makes, so its absence has to be as
 * loud as its failure.
 */

const TESTS_DIR = fileURLToPath(new URL(".", import.meta.url));

/** The files that carry the isolation and access-control proofs. Losing any one
 *  of these is a silent downgrade of the guarantee, not a refactor. */
const LOAD_BEARING = [
  "tenant-isolation.test.ts",
  "rls-coverage.test.ts",
  "platform-admin-lock.test.ts",
  "roles.test.ts",
];

/** Lower bound, not an exact count — new suites are welcome, vanishing ones are
 *  not. Raise it when the floor genuinely moves. */
const MINIMUM_TEST_FILES = 11;

describe("suite presence", () => {
  const files = readdirSync(TESTS_DIR).filter((f) => f.endsWith(".test.ts"));

  it.each(LOAD_BEARING)("still ships %s", (name) => {
    expect(files).toContain(name);
  });

  it("still ships at least the expected number of test files", () => {
    expect(files.length).toBeGreaterThanOrEqual(MINIMUM_TEST_FILES);
  });
});
