import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The boundaries link back into the app; next/link needs an app-router context
// a bare renderToStaticMarkup doesn't provide — a plain anchor is equivalent.
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import ShellError from "../app/(shell)/error";
import ShellNotFound from "../app/(shell)/not-found";

/**
 * The shell keeps its nav when a page fails. Without these boundaries the only
 * one is the root error boundary, which renders its own <html> and so replaces
 * the whole document — the owner loses the sidebar, the workspace switcher, and
 * any way back — and a stale link falls through to Next's bare 404.
 */
describe("shell error boundary", () => {
  const noop = () => {};

  it("recovers inside the shell — no document of its own", () => {
    const html = renderToStaticMarkup(<ShellError error={new Error("boom")} reset={noop} />);
    expect(html).not.toContain("<html");
    expect(html).not.toContain("<body");
    expect(html).toContain("Try again");
  });

  it("quotes the digest so a report can be traced, and never the raw message", () => {
    const error = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432"), {
      digest: "a1b2c3d4",
    });
    const html = renderToStaticMarkup(<ShellError error={error} reset={noop} />);
    expect(html).toContain("a1b2c3d4");
    expect(html).not.toContain("ECONNREFUSED");
  });
});

describe("shell not-found boundary", () => {
  it("renders inside the shell with a way back", () => {
    const html = renderToStaticMarkup(<ShellNotFound />);
    expect(html).not.toContain("<html");
    expect(html).toContain('href="/today"');
  });
});
