import { describe, expect, it, vi } from "vitest";

/**
 * The Create workspace button sat disabled on an unmet condition and said
 * nothing about it, so an operator who had filled one field got a control that
 * simply refused to respond — "they might just remain there clicking the button
 * forever", as the report put it. It presses now, and says what is still needed.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

import { whatIsMissing } from "../app/admin/provision-form";

describe("what the provision form asks for", () => {
  it("passes a complete, valid form", () => {
    expect(whatIsMissing("Westlands Beauty", "owner@theirshop.co.ke")).toBeNull();
  });

  it("names the shop name when it is empty or too short", () => {
    for (const name of ["", "  ", "A", " A "]) {
      expect(whatIsMissing(name, "owner@shop.co.ke"), JSON.stringify(name)).toContain("name");
    }
  });

  it("names the email when it is missing", () => {
    expect(whatIsMissing("Westlands Beauty", "")).toContain("email");
    expect(whatIsMissing("Westlands Beauty", "   ")).toContain("email");
  });

  it("catches an address that is not one, rather than provisioning against it", () => {
    // The owner gets an invite at this address and becomes the owner by
    // accepting it — a typo here leaves a workspace nobody can open.
    for (const bad of ["owner", "owner@", "@shop.co.ke", "owner@shop", "owner shop.co.ke"]) {
      expect(whatIsMissing("Westlands Beauty", bad), bad).toContain("email address");
    }
  });

  it("asks for one thing at a time, in the order the fields appear", () => {
    // Both wrong: the message is about the name, which is the field above.
    expect(whatIsMissing("", "")).toContain("name");
  });

  it("always says something a person can act on", () => {
    for (const [name, email] of [["", ""], ["A", "x"], ["Shop", "nope"]]) {
      const message = whatIsMissing(name!, email!);
      expect(message, `${name}/${email}`).toBeTruthy();
      // Not a token, not a field path — a sentence.
      expect(message!.endsWith(".")).toBe(true);
      expect(message).not.toContain("_");
    }
  });
});
