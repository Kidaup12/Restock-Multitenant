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

  it("reaches Pricing and Contact from inside the app", () => {
    // Both pages were orphaned — no link from anywhere, signed in or out.
    const shell = readFileSync(join("components", "shell", "app-shell.tsx"), "utf8");
    expect(shell).toContain('"pricing"');
    expect(shell).toContain('"contact"');
  });
});
