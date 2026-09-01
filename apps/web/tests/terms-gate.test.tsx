import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

import { TermsGate } from "@/app/(shell)/terms-gate";

/**
 * The gate itself. Whether it is SHOWN is decided by
 * `readTermsAcceptance(...).current` in the shell layout, and that predicate has
 * its own tests (terms-acceptance.test.ts) covering never-accepted, an older
 * version not counting, and re-stamping after a bump.
 *
 * What is asserted here is the part a gate can get quietly wrong: letting
 * someone through without the tickbox. A consent record produced by a gate with
 * a way past it is worse than no record — it says someone agreed when the
 * product would have let them in either way.
 */

const html = () => renderToStaticMarkup(<TermsGate version="2026-08-01" />);

describe("the terms gate", () => {
  it("blocks the screen rather than sitting in a corner", () => {
    const out = html();
    expect(out).toContain('aria-modal="true"');
    expect(out, "a gate that does not cover the page is a notice").toContain("fixed inset-0");
  });

  it("cannot be accepted until the box is ticked", () => {
    // First paint is unticked, so the button must carry the disabled ATTRIBUTE.
    //
    // Asserted as `disabled=""` on purpose. Searching for "disabled" matches
    // Tailwind's `disabled:pointer-events-none` in the class list, so it passes
    // whether or not the button is actually disabled — the first version of
    // this test did exactly that and survived the control that removed the
    // guard entirely.
    const out = html();
    expect(out, "a stray click could stand as agreement").toContain('disabled=""');
  });

  it("offers no way past it", () => {
    // No dismiss, no skip, no close. Sign-out is the other door and lives in
    // the sidebar behind the overlay.
    const out = html();
    for (const escape of ["Skip", "Later", "Dismiss", "Not now", "aria-label=\"Close\""]) {
      expect(out, `the gate offers "${escape}"`).not.toContain(escape);
    }
  });

  it("links the documents it is asking about", () => {
    const out = html();
    expect(out).toContain('href="/terms"');
    expect(out).toContain('href="/privacy"');
  });

  it("says which version is being accepted", () => {
    // "Accepted" without saying WHAT was accepted is the empty reassurance the
    // schema used to give.
    expect(html()).toContain("2026-08-01");
  });
});
