import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CurrencyProvider } from "../components/currency-provider";
import { DEFAULT_BUDGET_COVER_DAYS } from "../app/(shell)/plan/cover";

/**
 * What budget mode actually offers on first paint.
 *
 * The cover target ships switched ON, so the horizon is part of the question the
 * screen asks rather than a setting to go and find. That is a claim about
 * rendered markup, and the arithmetic tests next door cannot see it: they call
 * the action directly and never draw the control. A default silently flipped to
 * off would leave every one of them green.
 */

// next/link and the router want an app-router context a bare static render
// doesn't provide.
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/plan",
}));

const { BudgetPlanner } = await import("../app/(shell)/plan/budget-planner");

const markup = () =>
  renderToStaticMarkup(
    <CurrencyProvider currency="KES">
      <BudgetPlanner canViewCosts />
    </CurrencyProvider>
  );

describe("budget mode's cover target on first paint", () => {
  it("offers the control already switched on", () => {
    const html = markup();
    const checkbox = html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0] ?? "";
    expect(checkbox, "the cover-target checkbox must render").not.toBe("");
    expect(checkbox, "it must ship ticked — an untouched budget still states a horizon").toContain(
      "checked"
    );
  });

  it("names the horizon it opens with, in days", () => {
    expect(markup()).toContain(`${DEFAULT_BUDGET_COVER_DAYS} days`);
  });

  it("explains what the horizon does rather than just showing a number", () => {
    // A bare "21 days" beside a budget box is not an explanation, and this screen
    // explains every other figure it prints.
    expect(markup()).toMatch(/days of cover/i);
  });

  it("still shows the budget field and its presets", () => {
    const html = markup();
    expect(html).toMatch(/Budget \(KES\)/);
    expect(html).toContain("Plan my restock");
  });
});
