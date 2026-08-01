import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every writing action in the console asks for the password.
 *
 * There is no shared action wrapper here — each action re-runs its own guards —
 * so the guard that gets forgotten is the one nobody notices, and it will be on
 * whichever action was added last. A behavioural test only covers the actions
 * that exist when it is written; this covers the next one too.
 */

const adminRoot = fileURLToPath(new URL("../app/admin", import.meta.url));

/** Writes, in the sense that matters: it changes stored state or the ledger. */
const WRITE_MARKERS = [
  "prismaService.",
  "prismaForTenant(",
  "recordAdminEvent",
  "provisionWorkspace(",
  "setAdminTenantCookie",
];

/**
 * Exported actions that write but deliberately do NOT step up. Each needs a
 * reason, because the default has to be that they do.
 */
const DELIBERATELY_UNGUARDED = [
  // Ends a workspace visit and clears the grant. Guarding the way OUT would
  // leave an admin holding an expired step-up inside someone's workspace with
  // no way to leave, which is worse than the write it would prevent.
  "actions.ts:exitWorkspace",
  // This IS the step-up: it verifies the password and mints the grant. Its own
  // guards are the throttle and the gate.
  "step-up-actions.ts:confirmStepUp",
];

function actionFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return actionFiles(full);
    return /actions\.tsx?$/.test(entry) ? [full] : [];
  });
}

/** Split a "use server" module into its exported async functions. */
function exportedActions(source: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const re = /export\s+async\s+function\s+(\w+)/g;
  const starts = [...source.matchAll(re)];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]!.index;
    const to = i + 1 < starts.length ? starts[i + 1]!.index : source.length;
    out.push({ name: starts[i]![1]!, body: source.slice(from, to) });
  }
  return out;
}

describe("step-up adoption across the console", () => {
  it("every exported action that writes also checks for a step-up grant", () => {
    const offenders: string[] = [];

    for (const file of actionFiles(adminRoot)) {
      const source = readFileSync(file, "utf8");
      const rel = path.relative(adminRoot, file).replace(/\\/g, "/");

      for (const action of exportedActions(source)) {
        const writes = WRITE_MARKERS.some((m) => action.body.includes(m));
        if (!writes) continue;
        if (action.body.includes("hasStepUp")) continue;

        const site = `${rel}:${action.name}`;
        if (DELIBERATELY_UNGUARDED.includes(site)) continue;
        offenders.push(site);
      }
    }

    expect(
      offenders,
      "add `if (!(await hasStepUp(admin)))` to these, or list them in DELIBERATELY_UNGUARDED with a reason"
    ).toEqual([]);
  });

  it("the unguarded list names actions that still exist", () => {
    // An exemption for something that has been deleted or renamed reads as a
    // reviewed decision while exempting nothing.
    const seen = new Set<string>();
    for (const file of actionFiles(adminRoot)) {
      const rel = path.relative(adminRoot, file).replace(/\\/g, "/");
      for (const action of exportedActions(readFileSync(file, "utf8"))) {
        seen.add(`${rel}:${action.name}`);
      }
    }

    expect(DELIBERATELY_UNGUARDED.filter((entry) => !seen.has(entry))).toEqual([]);
  });
});
