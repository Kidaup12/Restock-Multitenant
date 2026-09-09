import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import path from "node:path";
import { coveredRoutes } from "../scripts/smoke-routes.mjs";

/**
 * Every page in the app is loaded by the HTTP smoke, or named as deliberately
 * skipped.
 *
 * The smoke run is the only check that exercises a page the way a browser does:
 * a server→client serialisation break builds clean, passes the whole vitest
 * suite, and answers 500 the moment a real request arrives. That is how
 * /inventory shipped broken with 1423 tests green.
 *
 * Its route list was hand-written and covered 16 of 46 pages, so the entire
 * settings section, the admin console, every detail page and the auth screens
 * had never been loaded over the wire by anything. A hand-written list does not
 * grow with the app — this test is what makes it grow: add a page.tsx and the
 * suite is red until someone decides how it should be checked.
 *
 * Derived from the filesystem rather than restated here, for the same reason.
 */

const APP = path.join(__dirname, "..", "app");

/** Segments Next.js does not put in the URL: route groups and private folders. */
const isGroup = (name: string) => name.startsWith("(") || name.startsWith("_");

/** Every page.tsx under app/, as the URL path it serves. */
function routesOnDisk(dir: string, url: string[] = []): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === "api" || entry.name === "node_modules") continue;
      out.push(
        ...routesOnDisk(
          path.join(dir, entry.name),
          isGroup(entry.name) ? url : [...url, entry.name]
        )
      );
    } else if (entry.name === "page.tsx") {
      out.push(url.length === 0 ? "/" : `/${url.join("/")}`);
    }
  }
  return out;
}

/**
 * Pages the smoke cannot reach, each with the reason. A route belongs here only
 * when loading it over HTTP is impossible, not when it is inconvenient — the
 * list is short on purpose, and an entry without a reason is not an entry.
 */
const SKIP: Record<string, string> = {};

describe("every page is loaded by the HTTP smoke", () => {
  const onDisk = routesOnDisk(APP);

  it("found the app's pages at all", () => {
    // Without this the walk could return nothing and every assertion below
    // would pass over an empty list.
    expect(onDisk.length, "the route walk found no pages — it is looking in the wrong place").toBeGreaterThan(
      30
    );
    expect(onDisk, "the walk missed the dashboard").toContain("/today");
    expect(onDisk, "route groups are being treated as URL segments").not.toContain("/(shell)/today");
  });

  it("accounts for every one of them", () => {
    const covered = new Set(coveredRoutes());
    const missing = onDisk.filter((r) => !covered.has(r) && !(r in SKIP));
    expect(
      missing,
      `these pages are never loaded over HTTP by anything — add them to apps/web/scripts/smoke-routes.mjs, or to SKIP here with a reason:\n  ${missing.join("\n  ")}`
    ).toEqual([]);
  });

  it("claims no route that does not exist", () => {
    // The other direction: a page renamed or deleted leaves a line in the smoke
    // list that can never fail, which reads exactly like coverage.
    const disk = new Set(onDisk);
    const stale = coveredRoutes().filter((r) => !disk.has(r));
    expect(
      stale,
      `the smoke list names pages that are not in the app any more:\n  ${stale.join("\n  ")}`
    ).toEqual([]);
  });

  it("skips nothing without saying why", () => {
    for (const [route, reason] of Object.entries(SKIP)) {
      expect(reason.length, `${route} is skipped with no reason given`).toBeGreaterThan(20);
    }
  });
});
