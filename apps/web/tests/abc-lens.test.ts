import { describe, expect, it } from "vitest";
import { ABC_KEYS, DEFAULT_ABC, abcLabel, matchesAbc, parseAbcKey } from "../lib/data/abc-lens";

/**
 * The A/B/C lens.
 *
 * The case that matters is the unclassified product. abcCategory is written by
 * the nightly run, so a young shop's whole catalogue is null. A lens that hid
 * those rows would show an empty report to a shop whose data is perfectly fine
 * — and it would do it silently, which is how this codebase has lost features
 * before.
 */

const a = { abc: "A" };
const c = { abc: "C" };
const unrated = { abc: null };

describe("the A/B/C lens", () => {
  it("never hides an unclassified product from the default view", () => {
    expect(matchesAbc(unrated, DEFAULT_ABC)).toBe(true);
  });

  it("gives unclassified products a lens of their own", () => {
    expect(matchesAbc(unrated, "unrated")).toBe(true);
    expect(matchesAbc(a, "unrated")).toBe(false);
  });

  it("does not sweep unclassified rows into a real class", () => {
    // The quiet wrong answer: treating null as C would report a young shop's
    // entire catalogue as its worst sellers.
    for (const key of ["A", "B", "C"] as const) {
      expect(matchesAbc(unrated, key), `unrated leaked into class ${key}`).toBe(false);
    }
  });

  it("selects only the asked-for class", () => {
    expect(matchesAbc(a, "A")).toBe(true);
    expect(matchesAbc(c, "A")).toBe(false);
    expect(matchesAbc(c, "C")).toBe(true);
  });

  it("labels every key", () => {
    for (const key of ABC_KEYS) expect(abcLabel(key), `${key} has no label`).toBeTruthy();
  });

  it("falls back on anything a visitor can type", () => {
    for (const junk of [null, undefined, "", "a", "D", "ALL"]) {
      expect(parseAbcKey(junk)).toBe(DEFAULT_ABC);
    }
    for (const key of ABC_KEYS) expect(parseAbcKey(key)).toBe(key);
  });
});
