import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Nothing in the web app opens its own Prisma transaction — `prismaForTenantTx`
 * is the only sanctioned way to make several statements atomic for a tenant.
 *
 * `prismaForTenant` wraps EVERY operation in a transaction of its own, so a
 * hand-rolled `$transaction` around it nests one inside another: the inner
 * statement waits for a connection the outer one is still holding. Whether that
 * deadlocks depends entirely on the pool — a generous local pool absorbs it and
 * every test passes, while a one-connection serverless runtime hangs until the
 * interactive-transaction timeout expires. The write had already committed by
 * then, so the caller saw an error page for work that had actually been done.
 *
 * A runtime test cannot catch it without pinning `connection_limit=1` for the
 * whole suite, so the rule is enforced against the source instead.
 */

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", ".next", "tests"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      return SKIP_DIRS.has(entry) ? [] : sourceFiles(full);
    }
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

describe("tenant transactions", () => {
  it("are opened through prismaForTenantTx, never by hand", () => {
    const files = sourceFiles(webRoot);
    // Without this the walk could return nothing and the rule would read green
    // while enforcing itself against an empty list.
    expect(files.length, "the source walk found no files to check").toBeGreaterThan(100);

    const offenders = files
      .filter((file) => /\.\$transaction\s*\(/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(webRoot, file));

    expect(offenders, "use prismaForTenantTx instead of opening a transaction here").toEqual([]);
  });
});
