import { describe, expect, it } from "vitest";
import { dismissGuide, isGuideDismissed, resetGuides } from "@/lib/guides";

/**
 * When a page explainer stops appearing.
 *
 * The box itself is trivial; the behaviour worth guarding is the dismissal
 * rule. Six explainers that each demand their own "Got it" turn a first session
 * into a chore, so dismissing one quiets the rest — but only within that
 * workspace, and only for guides that agreed to speak for the others.
 */

function memory(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

describe("page explainers", () => {
  it("shows before anyone has dismissed anything", () => {
    expect(isGuideDismissed(memory(), "shop-1", "products")).toBe(false);
  });

  it("one Got it quiets the rest", () => {
    const s = memory();
    dismissGuide(s, "shop-1", "today");
    expect(isGuideDismissed(s, "shop-1", "today")).toBe(true);
    expect(
      isGuideDismissed(s, "shop-1", "products"),
      "every page still asks to be dismissed on its own",
    ).toBe(true);
  });

  it("does not quiet a different workspace", () => {
    // The same person can be new to a second shop; the explanations there have
    // not been read just because they were read here.
    const s = memory();
    dismissGuide(s, "shop-1", "today");
    expect(
      isGuideDismissed(s, "shop-2", "today"),
      "dismissing in one workspace quieted a different one",
    ).toBe(false);
  });

  it("an independent guide neither speaks for the others nor is silenced by them", () => {
    const s = memory();
    dismissGuide(s, "shop-1", "special", true);
    expect(
      isGuideDismissed(s, "shop-1", "products"),
      "an independent guide silenced the whole set",
    ).toBe(false);

    const t = memory();
    dismissGuide(t, "shop-1", "today");
    expect(
      isGuideDismissed(t, "shop-1", "special", true),
      "the shared flag silenced a guide that opted out of it",
    ).toBe(false);
  });

  it("brings them all back for that workspace only", () => {
    const s = memory();
    dismissGuide(s, "shop-1", "today");
    dismissGuide(s, "shop-2", "today");
    resetGuides(s, "shop-1");
    expect(isGuideDismissed(s, "shop-1", "today")).toBe(false);
    expect(isGuideDismissed(s, "shop-2", "today"), "reset reached another workspace").toBe(true);
  });
});
