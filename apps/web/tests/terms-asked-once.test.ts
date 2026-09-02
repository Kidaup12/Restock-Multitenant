import { describe, expect, it } from "vitest";
import {
  effectiveTermsAcceptance,
  hasAcceptedCurrentTerms,
  readTermsAcceptance,
} from "@/lib/auth/terms";
import { TERMS_VERSION } from "@/lib/legal";

/**
 * The terms are asked of a PERSON, once per published version.
 *
 * Reported from production: the gate reappeared in a different browser for
 * someone who had already accepted. The record is in the database, so it was
 * never a storage problem — the gate read the ACTIVE membership, and a browser
 * with no workspace cookie resolves to the user's EARLIEST workspace. Anyone in
 * two workspaces was therefore asked again on a machine they had not signed in
 * from before, having already agreed.
 */

const accepted = (at: string, version = TERMS_VERSION) => ({
  acceptedTermsAt: new Date(at),
  acceptedTermsVersion: version,
});
const never = { acceptedTermsAt: null, acceptedTermsVersion: null };

describe("terms are asked once per person", () => {
  it("does not ask again when another workspace already accepted", () => {
    // The reported bug: the earliest workspace is unstamped, so it was the one
    // a fresh browser landed on and the one the gate judged.
    const memberships = [never, accepted("2026-08-30T10:00:00Z")];
    expect(
      hasAcceptedCurrentTerms(memberships),
      "someone who has already agreed is asked again in a new browser",
    ).toBe(true);
  });

  it("still asks someone who has never accepted anywhere", () => {
    expect(hasAcceptedCurrentTerms([never, never])).toBe(false);
    expect(hasAcceptedCurrentTerms([])).toBe(false);
  });

  it("asks again when the terms themselves change", () => {
    // The deliberate re-ask. Consent is to wording, so a new version is a new
    // question — this must NOT be swallowed by the fix above.
    const stale = [accepted("2026-08-30T10:00:00Z", "1900-01-01")];
    expect(hasAcceptedCurrentTerms(stale), "a version bump no longer re-asks").toBe(false);
  });

  it("shows Settings the acceptance the gate acted on", () => {
    // Otherwise the card reads "not accepted" — offering to do the thing the
    // app just decided had been done — on any workspace whose row is unstamped.
    const shown = effectiveTermsAcceptance(never, [never, accepted("2026-08-30T10:00:00Z")]);
    expect(shown.current).toBe(true);
    expect(shown.at?.toISOString()).toBe("2026-08-30T10:00:00.000Z");
  });

  it("prefers the most recent current acceptance", () => {
    const shown = effectiveTermsAcceptance(never, [
      accepted("2026-08-01T10:00:00Z"),
      accepted("2026-08-30T10:00:00Z"),
      accepted("2026-08-15T10:00:00Z"),
    ]);
    expect(shown.at?.toISOString()).toBe("2026-08-30T10:00:00.000Z");
  });

  it("shows a person who never accepted their own empty record", () => {
    // Not a stale stamp borrowed from a workspace they are not looking at.
    const shown = effectiveTermsAcceptance(never, [never]);
    expect(shown).toEqual(readTermsAcceptance(never));
  });
});
