import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A shared predicate is worth nothing until its consumers use it.
 *
 * CUSTOMER_TENANTS_WHERE exists so the platform workspace stays out of the
 * machinery meant for shops — the nightly crons, the fleet list, the
 * workspace-entry guard. Nothing at runtime notices when a new enumeration
 * forgets it: the symptom is a forecast job for a workspace with no products, or
 * a sales-gap alert on a shop that does not exist. This walks the source instead
 * and makes forgetting a failing test.
 *
 * Every broad Tenant query must either carry the predicate, scope to a single
 * id, or be named below with a reason for spanning everything.
 */

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const ROOTS = ["apps", "packages"];
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "tests", "prisma"]);

/** Call sites that span EVERY workspace on purpose. Additions are a reviewed
 *  decision: each needs to say why the platform workspace belongs in it. */
const DELIBERATELY_UNFILTERED = [
  // The audit filter dropdown. Platform-level events (granting admin, step-up)
  // key on the platform workspace, so leaving it out would make exactly the rows
  // this console exists to review the only ones that cannot be filtered.
  "apps/web/lib/admin/fleet.ts:listTenants",
  // Refusing a POS feed slug that would shadow another workspace's slug. It has
  // to see every slug in the database, the platform workspace's included, or a
  // shop could claim it.
  "apps/web/app/(shell)/settings/pos/actions.ts:setPosFeedSlug",
];

const BROAD_QUERY = /prismaService\.tenant\.(findMany|findFirst|count|aggregate|groupBy)\s*\(/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      return SKIP_DIRS.has(entry) ? [] : sourceFiles(full);
    }
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

/** The argument text of a call whose opening paren is at `open`. Brace/paren
 *  counting rather than a regex: the argument is an object literal that a
 *  non-greedy match would cut short at its first nested close. */
function callArguments(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return source.slice(open);
}

/** The exported symbol a call sits inside — enough to name a call site in the
 *  allow-list without parsing the file. Exported rather than nearest-binding:
 *  the nearest binding is usually the call's own `const`, which names the
 *  variable rather than the thing a reviewer would recognise. */
function enclosingName(source: string, offset: number): string {
  const matches = [
    ...source
      .slice(0, offset)
      .matchAll(/export\s+(?:async\s+)?function\s+(\w+)|export\s+const\s+(\w+)/g),
  ];
  const last = matches[matches.length - 1];
  return last ? (last[1] ?? last[2] ?? "?") : "?";
}

describe("system tenant exclusion", () => {
  it("every broad Tenant query filters the platform workspace or is allow-listed", () => {
    const offenders: string[] = [];

    for (const root of ROOTS) {
      for (const file of sourceFiles(path.join(repoRoot, root))) {
        const source = readFileSync(file, "utf8");
        const rel = path.relative(repoRoot, file).replace(/\\/g, "/");

        for (const match of source.matchAll(BROAD_QUERY)) {
          const open = match.index + match[0].length - 1;
          const args = callArguments(source, open);
          const site = `${rel}:${enclosingName(source, match.index)}`;

          if (args.includes("CUSTOMER_TENANTS_WHERE")) continue;
          // Scoped to ids the caller already resolved — not an enumeration. The
          // `id` has to be the first key of `where`: a nested one (`NOT: { id }`)
          // excludes a single workspace while still spanning all the others.
          if (/where:\s*\{\s*id:/.test(args)) continue;
          if (DELIBERATELY_UNFILTERED.includes(site)) continue;

          offenders.push(site);
        }
      }
    }

    expect(
      offenders,
      "spread CUSTOMER_TENANTS_WHERE into the query, or add the call site to DELIBERATELY_UNFILTERED with a reason"
    ).toEqual([]);
  });

  it("the allow-list names call sites that still exist", () => {
    // An allow-list entry that no longer matches anything is worse than none: it
    // reads as a reviewed exemption while exempting nothing.
    const seen = new Set<string>();

    for (const root of ROOTS) {
      for (const file of sourceFiles(path.join(repoRoot, root))) {
        const source = readFileSync(file, "utf8");
        const rel = path.relative(repoRoot, file).replace(/\\/g, "/");
        for (const match of source.matchAll(BROAD_QUERY)) {
          seen.add(`${rel}:${enclosingName(source, match.index)}`);
        }
      }
    }

    expect(DELIBERATELY_UNFILTERED.filter((entry) => !seen.has(entry))).toEqual([]);
  });
});
