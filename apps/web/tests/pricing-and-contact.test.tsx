import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PLAN_TIERS } from "@wezesha/db";
import {
  PLAN_ORDER,
  PLAN_FEATURE_LABEL,
  PLAN_TIER_LABEL,
} from "@/lib/capabilities/plan-features";
import { planCards, PLAN_PRICING } from "@/lib/pricing";
import { LEGAL } from "@/lib/legal";
import PricingPage from "@/app/pricing/page";
import ContactPage from "@/app/contact/page";
import { config as proxyConfig } from "@/proxy";

/**
 * The two public pages.
 *
 * A pricing page is the one screen a shop reads before it can check anything,
 * so the risk is not that it looks wrong — it is that it promises something the
 * app does not do. Everything on it except the price is derived from the code
 * that enforces it; these guard that derivation, and that nobody quietly types
 * a number in.
 */

const pricing = () => renderToStaticMarkup(<PricingPage />);
const contact = () => renderToStaticMarkup(<ContactPage />);

describe("pricing", () => {
  it("shows every tier the app actually has", () => {
    // A tier added to the engine and not to this page is a plan a shop can be
    // put on and never see described.
    const cards = planCards();
    expect(cards.map((c) => c.tier)).toEqual([...PLAN_ORDER]);
    const html = pricing();
    for (const tier of PLAN_ORDER) {
      expect(html, `${tier} is missing from the page`).toContain(PLAN_TIER_LABEL[tier]);
    }
  });

  it("describes every feature the app gates on", () => {
    // A feature nobody lists is one a shop pays for without knowing, or is
    // refused without warning.
    // Against the RENDERED page, not the model behind it: the page shows the
    // full list for the first tier and only the additions after, so "every
    // feature is in some card" can hold while the page still shows none of it.
    const html = pricing();
    for (const label of Object.values(PLAN_FEATURE_LABEL)) {
      expect(html, `the page never mentions "${label}"`).toContain(label);
    }
  });

  it("quotes the caps the app enforces, not rounder ones", () => {
    for (const card of planCards()) {
      expect(card.limits.products).toBe(PLAN_TIERS[card.tier]!.maxProducts);
      expect(card.limits.members).toBe(PLAN_TIERS[card.tier]!.maxMembers);
    }
    // And they reach the page.
    expect(pricing()).toContain("20,000");
  });

  it("shows each tier only what it ADDS over the one below", () => {
    // An inclusive list repeats the same lines three times and hides the actual
    // difference, which is the only thing a reader is comparing.
    const [starter, growth, scale] = planCards();
    expect(starter!.adds).toEqual(starter!.includes);
    expect(growth!.adds).not.toContain(PLAN_FEATURE_LABEL.core_ordering);
    expect(starter!.includes).toContain(PLAN_FEATURE_LABEL.budget_planner);
    expect(scale!.adds).toContain(PLAN_FEATURE_LABEL.team_depth);
    expect(scale!.adds, "Scale re-lists what Growth already gave").not.toContain(
      PLAN_FEATURE_LABEL.transfers,
    );
  });

  it("invents no price", () => {
    // The one number on this page that is not a fact about the software. Until
    // someone with the authority to set it does, the page says so rather than
    // publishing a figure nobody committed to.
    const html = pricing();
    for (const card of planCards()) {
      if (card.monthlyKes == null) continue;
      expect(html).toContain(String(card.monthlyKes));
    }
    if (PLAN_PRICING.every((p) => p.monthlyKes == null)) {
      expect(html).toContain("Priced per shop");
      expect(html).toContain("Get a price");
      // The price slot and the button must not say the same thing — side by
      // side they read as a stutter rather than as a price and an action.
      expect(html.match(/Talk to us/g) ?? [], "the price slot repeats the button").toHaveLength(0);
      expect(html, "a price appeared with no price set").not.toMatch(/KES\s*[\d,]+\s*<[^>]*>\s*\/\s*month/);
    }
  });

  it("is reachable without an account", () => {
    // Someone reads this before they can sign in. A pricing page behind the
    // login is a pricing page nobody reads.
    for (const pattern of proxyConfig.matcher) {
      expect(pattern.startsWith("/pricing")).toBe(false);
      expect(pattern.startsWith("/contact")).toBe(false);
    }
  });
});

describe("contact", () => {
  it("names one mailbox, the same one the privacy policy names", () => {
    // Two addresses is one address that stops being watched.
    expect(contact()).toContain(LEGAL.privacyContact);
  });

  it("sorts people by what they need", () => {
    const html = contact();
    expect(html).toContain("Thinking about using it");
    expect(html).toContain("Already a customer");
    expect(html).toContain("About your data");
  });

  it("renders the shared footer rather than its own", () => {
    // Both pages used to build the tagline inline as `{LEGAL.product} · demand`,
    // which JSX collapses to "Wezesha Restock· demand" at the expression
    // boundary. The tagline now lives as one constant in SiteFooter, where the
    // boundary does not exist — tests/site-footer.test.tsx guards that there is
    // exactly one footer, so the trap cannot come back page by page.
    for (const html of [pricing(), contact()]) {
      expect(html).toContain("Wezesha Restock OS · demand");
    }
  });

  it("offers no form", () => {
    // A form implies a queue behind it that answers. There is not one, and a
    // form that drops messages nowhere looks like a promise.
    const html = contact();
    expect(html, "a contact form appeared with nothing behind it").not.toContain("<form");
    expect(html).toContain(`mailto:${LEGAL.privacyContact}`);
  });
});
