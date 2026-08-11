import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every page you can only reach by clicking a row must say where it sits.
 *
 * A nested page has no other way back — the sidebar highlights the section, not
 * the record — so a purchase order or a product page was a dead end. This walks
 * the route tree rather than naming today's pages, so a nested screen added
 * later fails here until it carries a trail.
 */

const APP = path.join(__dirname, "..", "app");

/** Route groups (bracketed folders) are not URL segments. */
const isRouteGroup = (segment: string) => segment.startsWith("(") && segment.endsWith(")");

/** Pages with no shell chrome at all — a trail would have nothing to sit in. */
const CHROMELESS = [
  path.join("orders", "[id]", "print"), // print view: the sheet a supplier receives
];

function routePages(dir: string, segments: string[] = []): { file: string; url: string[] }[] {
  const out: { file: string; url: string[] }[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...routePages(full, isRouteGroup(entry) ? segments : [...segments, entry]));
    } else if (entry === "page.tsx") {
      out.push({ file: full, url: segments });
    }
  }
  return out;
}

const pages = routePages(APP);

/** Nested = at least two URL segments, inside the signed-in surfaces. */
const nested = pages.filter(({ url, file }) => {
  if (url.length < 2) return false;
  // Signed-out surfaces have no shell to be nested in: you are not "inside"
  // anything yet, and there is nowhere behind you to go.
  if (file.includes("(auth)")) return false;
  const top = url[0]!;
  if (top === "invite") return false; // reached from an email, no parent to return to
  if (top === "workspaces") return false; // creating your first workspace has no list behind it
  const rel = url.join(path.sep);
  return !CHROMELESS.some((c) => rel.endsWith(c));
});

describe("breadcrumbs on nested pages", () => {
  it("finds the nested routes at all (guards the walker itself)", () => {
    const urls = nested.map((p) => "/" + p.url.join("/"));
    expect(urls).toContain("/orders/[id]");
    expect(urls).toContain("/stock/[productId]");
    expect(urls).toContain("/settings/team");
    expect(urls.length).toBeGreaterThanOrEqual(9);
  });

  it.each(nested.map((p) => ["/" + p.url.join("/"), p.file] as const))(
    "%s renders a breadcrumb trail",
    (_url, file) => {
      expect(readFileSync(file, "utf8")).toContain("breadcrumbs={");
    }
  );

  it("keeps the print view chromeless", () => {
    const print = pages.find((p) => p.url.join("/") === "orders/[id]/print");
    expect(print).toBeDefined();
    expect(readFileSync(print!.file, "utf8")).not.toContain("breadcrumbs={");
  });
});
