import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Every search box on a long table hides its submit button while the box is
 * empty. An empty search has nothing to do: with no text the server returns the
 * unfiltered list, which is what `Clear` already is.
 *
 * The hiding is CSS — `peer` on the input, `peer-placeholder-shown:hidden` on
 * the button — so no stylesheet runs here and no assertion can watch the button
 * disappear. What these tests hold instead is the three things the CSS silently
 * depends on, each of which a refactor can drop while the markup still looks
 * right: the input carries `peer`, the input has a placeholder (`:placeholder-
 * shown` never matches without one), and the button comes AFTER the input, since
 * the peer selector only reaches later siblings.
 *
 * Move the button above the input and every one of those classes stays in the
 * file while the button stops hiding. That is the failure this guards.
 */

// next/link wants an app-router context a bare static render doesn't provide.
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { TableSearch } from "../components/ui/table-search";
import { CatalogueSearch } from "../app/(shell)/stock/catalogue-search";
import { DEFAULT_QUERY } from "../lib/catalogue";

/** The submit button's markup, and the input's, in document order. */
function parts(html: string) {
  const input = html.match(/<input[^>]*name="q"[^>]*>/)?.[0] ?? "";
  const button = html.match(/<button[^>]*type="submit"[^>]*>/)?.[0] ?? "";
  return { input, button, inputAt: html.indexOf(input), buttonAt: html.indexOf(button) };
}

function expectHidesWhileEmpty(html: string) {
  const { input, button, inputAt, buttonAt } = parts(html);
  expect(input, "the search input must render").not.toBe("");
  expect(button, "the submit button must render").not.toBe("");

  // The peer relationship, the placeholder it reads, and the sibling order.
  expect(input).toContain("peer");
  expect(input).toMatch(/placeholder="[^"]+"/);
  expect(button).toContain("peer-placeholder-shown:hidden");
  expect(buttonAt).toBeGreaterThan(inputAt);
}

describe("a search box offers no submit button until something is typed", () => {
  it("the shared table search hides it", () => {
    expectHidesWhileEmpty(
      renderToStaticMarkup(
        <TableSearch
          action="/activity"
          value=""
          placeholder="Search the log"
          clearHref="/activity"
        />
      )
    );
  });

  it("the catalogue's own search hides it", () => {
    expectHidesWhileEmpty(
      renderToStaticMarkup(
        <CatalogueSearch query={DEFAULT_QUERY} matched={0} clearHref="/stock" />
      )
    );
  });

  it("a searched box still shows the button, so the reader can search again", () => {
    const html = renderToStaticMarkup(
      <TableSearch
        action="/activity"
        value="lipstick"
        placeholder="Search the log"
        clearHref="/activity"
      />
    );
    // The class is unconditional; the browser drops it once the box has a value.
    // What must hold in the markup is that the value is there to be read.
    expect(parts(html).input).toContain('value="lipstick"');
    expect(html).toContain("Clear");
  });
});
