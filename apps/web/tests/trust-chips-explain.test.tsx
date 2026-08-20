import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CONFIDENCE_COPY,
  COLD_START_COPY,
  TrustChips,
} from "../app/(shell)/plan/buy-checklist";
import type { PlanColdStart, PlanConfidence } from "../lib/data/plan";

/**
 * The honesty chips have to say what they mean where they are read.
 *
 * "Sure", "Fairly sure", "Guessing", "Selling like X" are one or two words each,
 * and the sentences explaining them already existed — but only inside the
 * expanded "why this quantity" panel. A shop scanning the buy list met the words
 * with no way to learn what they meant short of opening every row, which is the
 * opposite of what a trust signal is for.
 */

const CONFIDENCES: PlanConfidence[] = ["sure", "fairly_sure", "guessing"];
const COLD: PlanColdStart[] = ["too_new", "borrowed"];

const render = (row: Parameters<typeof TrustChips>[0]["row"]) =>
  renderToStaticMarkup(<TrustChips row={row} />);

/** React escapes attribute text, so the expectation has to be escaped too — an
 *  apostrophe arrives as &#x27; and a raw comparison never matches. */
const escaped = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");

describe("trust chips explain themselves", () => {
  it("carries each confidence word's own sentence", () => {
    for (const confidence of CONFIDENCES) {
      const html = render({ confidence, coldStart: null, borrowedFromTitle: null });
      expect(html, confidence).toContain(CONFIDENCE_COPY[confidence].chip);
      // The sentence is on the chip, not only in the panel below it.
      expect(html, confidence).toContain(escaped(CONFIDENCE_COPY[confidence].sentence));
      expect(html, confidence).toContain("title=");
    }
  });

  it("explains the cold-start chips too", () => {
    for (const coldStart of COLD) {
      const html = render({ confidence: null, coldStart, borrowedFromTitle: "Vaseline 400ml" });
      expect(html, coldStart).toContain(
        escaped(COLD_START_COPY[coldStart].sentence("Vaseline 400ml"))
      );
    }
  });

  it("renders nothing at all for a run that recorded neither", () => {
    // An older plan says nothing rather than claiming a confidence it never had.
    expect(render({ confidence: null, coldStart: null, borrowedFromTitle: null })).toBe("");
  });

  it("never prints an engine token", () => {
    for (const confidence of CONFIDENCES) {
      const html = render({ confidence, coldStart: null, borrowedFromTitle: null });
      expect(html, confidence).not.toContain("fairly_sure");
      expect(html, confidence).not.toContain("too_new");
    }
  });
});
