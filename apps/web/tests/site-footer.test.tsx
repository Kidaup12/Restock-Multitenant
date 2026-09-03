import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SiteFooter } from "@/components/ui/site-footer";

/**
 * One footer, and the two pages nothing linked to.
 *
 * Three hand-written copies appeared within a day and had already disagreed on
 * the product name — the shell said "Wezesha Restock OS", the public pages
 * interpolated the LEGAL entity name. Meanwhile Pricing and Contact existed and
 * nothing anywhere linked to them: built, unreachable, which is not shipped.
 */

describe("site footer", () => {
  it("names the product the way the brand does", () => {
    const html = renderToStaticMarkup(<SiteFooter />);
    expect(html).toContain("Wezesha Restock OS");
    expect(html).toContain("demand &amp; reorder intelligence for beauty retailers");
  });

  it("carries the links it is given, and no others", () => {
    const html = renderToStaticMarkup(<SiteFooter links={["pricing", "contact"]} />);
    expect(html).toContain('href="/pricing"');
    expect(html).toContain('href="/contact"');
    expect(html).not.toContain('href="/terms"');
  });

  it("is the only footer in the app", () => {
    // The defect was three copies drifting apart. A second <footer> written by
    // hand is how that starts again.
    const roots = ["app", "components"];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx$/.test(entry.name) && full !== join("components", "ui", "site-footer.tsx")) {
          if (/<footer[\s>]/.test(readFileSync(full, "utf8"))) offenders.push(full);
        }
      }
    };
    roots.forEach(walk);
    expect(offenders, `hand-written <footer> outside the shared one: ${offenders.join(", ")}`).toEqual([]);
  });

  it("turns the shell's footer links into real anchors", () => {
    // The weak version grepped app-shell.tsx for the strings "pricing" and
    // "contact" — which survive inside a COMMENT, so commenting the footer out
    // (orphaning both pages again) still passed. Render the footer with the set
    // the shell passes and assert the anchors actually exist.
    const html = renderToStaticMarkup(
      <SiteFooter links={["pricing", "contact", "terms", "privacy"]} />,
    );
    expect(html).toContain('href="/pricing"');
    expect(html).toContain('href="/contact"');
  });

  it("wires that footer into the shell, not just a comment", () => {
    // The one source fact left: the shell must RENDER <SiteFooter> with pricing
    // and contact among its links. The regex needs the actual JSX element and
    // its links prop, which a `//` comment cannot produce.
    const shell = readFileSync(join("components", "shell", "app-shell.tsx"), "utf8");
    expect(
      /<SiteFooter[\s\S]{0,160}links=\{[\s\S]{0,120}"pricing"[\s\S]{0,120}"contact"/.test(shell),
      "the shell no longer renders a SiteFooter carrying Pricing and Contact",
    ).toBe(true);
  });
});
