import { describe, expect, it } from "vitest";
import { routeForStep, STEP_ROUTES, tourStepsForRole } from "@/components/tour/steps";

/**
 * The tour walks you through the pages; it must not hold you on them.
 *
 * Reported from QA: during the first-run tour, clicking a sidebar link landed
 * you back on Today, and the app stayed that way until the tour was skipped.
 * The engine decided where to be on every pathname change, so the person's own
 * navigation was undone the moment it happened.
 */

const stepOf = (key: string) => ({ key });

describe("routeForStep", () => {
  it("sends the browser to the step's page the first time that step is shown", () => {
    expect(routeForStep(stepOf("plan"), "/today", null)).toBe("/plan");
  });

  it("leaves a person who navigates away mid-step exactly where they went", () => {
    // Step one has already had its navigation; the person then clicks Suppliers.
    expect(routeForStep(stepOf("today"), "/suppliers", "today")).toBeNull();
  });

  it("leaves a first-run visitor on the page they actually asked for", () => {
    // Auto-start spends step one's navigation before the walkthrough begins, so
    // someone who opened a link to Transfers stays on Transfers. Without this a
    // first visit to any deep link bounced to Today a second after it loaded.
    const first = tourStepsForRole("OWNER", true)[0]!;
    expect(routeForStep(first, "/transfers", first.key)).toBeNull();
    // A replay from the profile menu spends nothing, so it still walks to the
    // first step's page.
    expect(routeForStep(first, "/transfers", null)).toBe(STEP_ROUTES[first.key]);
  });

  it("still navigates when the step changes, including going Back", () => {
    expect(routeForStep(stepOf("orders"), "/today", "today")).toBe("/orders");
    expect(routeForStep(stepOf("today"), "/orders", "orders")).toBe("/today");
  });

  it("stays put when the step's page is already open", () => {
    expect(routeForStep(stepOf("plan"), "/plan", null)).toBeNull();
  });

  it("stays put for a step that has no page of its own", () => {
    // Shell-persistent targets (workspace switcher, theme, profile) are absent
    // from STEP_ROUTES on purpose — they show wherever you already are.
    expect(STEP_ROUTES["workspace"]).toBeUndefined();
    expect(routeForStep(stepOf("workspace"), "/stock", null)).toBeNull();
  });

  it("does nothing once the tour has ended", () => {
    expect(routeForStep(null, "/suppliers", "today")).toBeNull();
  });

  it("navigates again on a replay, when the first step is owed its page anew", () => {
    // The engine clears the marker on start(); without that, replaying from the
    // profile menu would show step one without ever going to its page.
    expect(routeForStep(stepOf("today"), "/stock", null)).toBe("/today");
  });

  it("covers every routed step in the owner's tour", () => {
    const steps = tourStepsForRole("OWNER", true);
    const routed = steps.filter((s) => STEP_ROUTES[s.key]);
    expect(routed.length).toBeGreaterThan(0);
    for (const s of routed) {
      expect(routeForStep(s, "/somewhere-else", null)).toBe(STEP_ROUTES[s.key]);
    }
  });
});
