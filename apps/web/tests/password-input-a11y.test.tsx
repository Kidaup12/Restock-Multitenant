import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PasswordInput } from "../components/auth/password-input";

/**
 * The reveal toggle sits inside the password field, so whatever it is called
 * competes with the field for label-based navigation. Named "Show password" it
 * meant asking for "Password" — by voice, by screen reader, or by a Playwright
 * getByLabel — could land on the button instead of the input.
 */

describe("password input accessibility", () => {
  it("keeps the word Password to the field, not the toggle", () => {
    const html = renderToStaticMarkup(
      <>
        <label htmlFor="pw">Password</label>
        <PasswordInput id="pw" />
      </>
    );

    const labels = [...html.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]!);
    expect(labels.length).toBeGreaterThan(0); // vacuity guard
    for (const label of labels) {
      expect(label.toLowerCase(), label).not.toContain("password");
    }

    // The toggle still says what it does, rather than going unnamed.
    expect(labels.some((l) => /show|hide/i.test(l))).toBe(true);
  });
});
