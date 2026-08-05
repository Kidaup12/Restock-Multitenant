import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  COLD_START_COPY,
  CONFIDENCE_COPY,
  EXCLUDED_GROUPS,
  SIZING_RULE_COPY,
  TrustChips,
} from "../app/(shell)/plan/buy-checklist";
import type { ExcludedReason, PlanColdStart, PlanConfidence } from "../lib/data/plan";

/**
 * The client is not technical. The forecast engine's vocabulary — min_max,
 * fairly_sure, coldStart — is ours, and none of it belongs on a shop owner's
 * screen. Every state the run can persist needs copy, and none of that copy may
 * be the raw token.
 */

const CONFIDENCES: PlanConfidence[] = ["sure", "fairly_sure", "guessing"];
const COLD_STARTS: PlanColdStart[] = ["too_new", "borrowed"];
const METHODS = ["mean_cover", "calibrated", "min_max"];
const REASONS: ExcludedReason[] = [
  "already-ordered",
  "unplannable",
  "slow-mover",
  "too-new",
  "covered",
];

describe("plan copy", () => {
  it("has shop language for every state the run can persist", () => {
    for (const c of CONFIDENCES) {
      expect(CONFIDENCE_COPY[c].chip.length, c).toBeGreaterThan(0);
      expect(CONFIDENCE_COPY[c].sentence.length, c).toBeGreaterThan(0);
    }
    for (const s of COLD_STARTS) {
      expect(COLD_START_COPY[s].chip(null).length, s).toBeGreaterThan(0);
      expect(COLD_START_COPY[s].sentence(null).length, s).toBeGreaterThan(0);
    }
    for (const m of METHODS) expect(SIZING_RULE_COPY[m], m).toBeTruthy();
    // Every reason the data layer can emit has a group to render it in — a new
    // reason without one would silently drop its rows off the page.
    for (const r of REASONS) {
      expect(EXCLUDED_GROUPS.find((g) => g.reason === r), r).toBeDefined();
    }
  });

  it("never prints an engine token", () => {
    const all = [
      ...CONFIDENCES.flatMap((c) => [CONFIDENCE_COPY[c].chip, CONFIDENCE_COPY[c].sentence]),
      ...COLD_STARTS.flatMap((s) => [
        COLD_START_COPY[s].chip("Cantu Curl Cream"),
        COLD_START_COPY[s].sentence("Cantu Curl Cream"),
      ]),
      ...METHODS.map((m) => SIZING_RULE_COPY[m]!),
      ...EXCLUDED_GROUPS.flatMap((g) => [g.title, g.subtitle]),
    ].join(" | ");

    expect(all).not.toMatch(/min_max|mean_cover|fairly_sure|too_new|coldStart|regime|explainParts/);
  });

  it("names a borrowed product, and stays sensible when it cannot", () => {
    expect(COLD_START_COPY.borrowed.chip("Cantu Curl Cream")).toContain("Cantu Curl Cream");
    // A deleted proxy resolves to null — never the string "null"/"undefined".
    expect(COLD_START_COPY.borrowed.chip(null)).toBe("Selling like a similar product");
    expect(COLD_START_COPY.borrowed.sentence(null)).not.toMatch(/null|undefined/);
  });

  it("renders the chips a row's trust columns earn, and nothing when it has none", () => {
    const html = renderToStaticMarkup(
      TrustChips({ row: { confidence: "guessing", coldStart: "too_new", borrowedFromTitle: null } })
    );
    expect(html).toContain("Guessing");
    expect(html).toContain("Too new");

    // A run written before the trust columns existed says nothing rather than
    // claiming a confidence it never recorded.
    const bare = renderToStaticMarkup(
      TrustChips({ row: { confidence: null, coldStart: null, borrowedFromTitle: null } })
    );
    expect(bare).toBe("");
  });
});
