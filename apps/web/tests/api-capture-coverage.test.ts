import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every API route handler must run inside `withCapture`, or say in EXEMPT why
 * it doesn't. An unwrapped throw is answered by Next's opaque 500 and never
 * reaches the tracker, so the first anyone hears of it is a user report — and
 * it arrives with no tenantId, which is the only tag that makes a report
 * triageable here.
 *
 * The directory walk is the point: a route added next month is red until
 * someone decides which side of the line it belongs on.
 */

const apiRoot = fileURLToPath(new URL("../app/api", import.meta.url));

/** Route ids (path under app/api, minus the /route.ts) that stay unwrapped. */
const EXEMPT: Record<string, string> = {
  // Liveness probe hit continuously by external monitors: it already answers
  // 503 for the failure it exists to detect, and has no session to tag.
  health: "uptime probe — its 503 IS the alert, and a monitor's polling would flood the tracker",
  // better-auth's own handler. `withCapture` tags the route with the request
  // pathname, and better-auth serves /reset-password/:token — the tag would
  // carry a live password-reset credential.
  "auth/[...all]": "credential-bearing pathnames (/reset-password/:token) must not become tags",
};

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return entry === "route.ts" ? [full] : [];
  });
}

/** "shopify/sync" for app/api/shopify/sync/route.ts. */
function routeId(file: string): string {
  return path.relative(apiRoot, path.dirname(file)).split(path.sep).join("/");
}

describe("api error capture coverage", () => {
  const files = routeFiles(apiRoot);

  it("finds the route files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("every route handler is wrapped in withCapture or exempt", () => {
    const uncovered = files
      .filter((file) => !/\bwithCapture\b/.test(readFileSync(file, "utf8")))
      .map(routeId)
      .filter((id) => !(id in EXEMPT))
      .sort();

    expect(uncovered).toEqual([]);
  });

  it("no stale exemptions", () => {
    const ids = new Set(files.map(routeId));
    expect(Object.keys(EXEMPT).filter((id) => !ids.has(id))).toEqual([]);
  });
});
