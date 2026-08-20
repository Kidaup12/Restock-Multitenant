import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NAV_DESTINATIONS } from "../components/shell/nav-config";
import { STEP_ROUTES, tourStepsForRole } from "../components/tour/steps";

/**
 * One name per screen, across the nav, the guided tour and the docs.
 *
 * Three surfaces used three vocabularies for the same pages: /insights was
 * "Reports" in the nav and "Insights" in the test plan, /products was "Products"
 * in the nav, "Stock (the catalogue)" in §8 and "Check the catalogue" in the
 * tour. The routes always matched — /stock redirects — so nothing was broken,
 * it just cost a tester time on every section of the plan, and would cost
 * support the same once customers write in.
 *
 * The nav is the authority: it is the word the shop actually clicks.
 */

const NAV_LABEL = new Map(NAV_DESTINATIONS.map((d) => [d.href, d.label]));

/** Names that used to mean one of these screens and must not come back. */
const RETIRED = ["Insights", "Stock (the catalogue)"];

/** Vitest runs with apps/web as the cwd. */
const docs = ["../../docs/QA-TESTPLAN.md", "../../docs/ARCHITECTURE.md"];

describe("one name per screen", () => {
  /**
   * Only the screens the tour used to RENAME. A headline is allowed to be
   * evocative — "Start your day here" over the nav's "Dashboard" is a welcome,
   * not a second name — but where it names the screen, it has to use the shop's
   * own word for it.
   */
  const NAMES_ITS_SCREEN = ["/products", "/inventory", "/insights"];

  it("gives the naming steps the nav's word for their page", () => {
    const steps = tourStepsForRole("OWNER");
    const checked: string[] = [];
    for (const step of steps) {
      const route = STEP_ROUTES[step.key];
      if (!route || !NAMES_ITS_SCREEN.includes(route)) continue;
      const label = NAV_LABEL.get(route)!;
      checked.push(step.key);
      // "Check the catalogue" named a screen the nav calls Products.
      expect(step.title, `${step.key} → ${route}`).toContain(label);
    }
    expect(checked).toHaveLength(NAMES_ITS_SCREEN.length); // vacuity guard
  });

  it("keeps the retired names out of the tour as well", () => {
    for (const step of tourStepsForRole("OWNER")) {
      for (const name of RETIRED) {
        expect(step.title, `${step.key}: ${step.title}`).not.toContain(name);
      }
    }
  });

  it("keeps the retired names out of the docs a tester follows", () => {
    for (const path of docs) {
      const text = readFileSync(path, "utf8");
      for (const name of RETIRED) {
        expect(text.includes(name), `${path} still says "${name}"`).toBe(false);
      }
    }
  });

  it("still documents the nav's own words", () => {
    // The opposite failure: scrubbing a name and replacing it with nothing.
    const plan = readFileSync("../../docs/QA-TESTPLAN.md", "utf8");
    expect(plan).toContain("Reports");
    expect(plan).toContain("Products");
  });
});
