import { describe, expect, it } from "vitest";
import {
  OPTIONAL_EMAIL_KINDS,
  parseNotifyPrefs,
  wantsEmail,
} from "../src/notify-prefs";

/**
 * The preference contract itself. It decides whether real mail goes out, and it
 * reads a JSON column that anything could have written, so the parsing is worth
 * pinning separately from the sending.
 */

describe("notify prefs", () => {
  it("treats absent, null and junk as wanting the email", () => {
    for (const value of [null, undefined, {}, [], 42, "yes", { weekly_summary: "no" }]) {
      expect(wantsEmail(value, "weekly_summary"), `${JSON.stringify(value)} silenced it`).toBe(
        true
      );
    }
  });

  it("silences only on an explicit false, and only the kind named", () => {
    const prefs = { weekly_summary: false };
    expect(wantsEmail(prefs, "weekly_summary")).toBe(false);
    expect(wantsEmail(prefs, "reconnect_alert")).toBe(true);
  });

  it("keeps only the keys this build knows", () => {
    const parsed = parseNotifyPrefs({
      weekly_summary: false,
      reconnect_alert: true,
      // Neither a kind nor a boolean — both must be dropped rather than stored.
      phantomPo: false,
      nonsense: { nested: true },
    });
    expect(Object.keys(parsed).sort()).toEqual(["reconnect_alert", "weekly_summary"]);
    expect(parsed.weekly_summary).toBe(false);
  });

  it("names every optional kind exactly once", () => {
    // A duplicate would render two identical switches and store one value.
    expect(new Set(OPTIONAL_EMAIL_KINDS).size).toBe(OPTIONAL_EMAIL_KINDS.length);
    expect(OPTIONAL_EMAIL_KINDS.length).toBeGreaterThan(0);
  });

  it("does not offer a transactional email as switchable", () => {
    // Nobody may opt out of an invite, a sign-in code, a password reset or the
    // purchase order itself — those answer something the person just did.
    for (const transactional of [
      "invite",
      "sign_in_code",
      "password_reset",
      "purchase_order",
    ]) {
      expect(OPTIONAL_EMAIL_KINDS as readonly string[]).not.toContain(transactional);
    }
  });
});
