import { describe, expect, it } from "vitest";
import { forecastRunMessage } from "../app/(shell)/today/run-forecast-button";

/**
 * A run that changes nothing looked identical to one that never fired: the
 * button had a spinner and a failure line but no confirmation, and the only
 * other signal on the page — "Plan computed 10 Aug" — is day-granular, so a
 * same-day re-run left every visible figure exactly as it was.
 *
 * The run's own response already carried the news (`created`); the button threw
 * the body away and checked only the status code.
 */

describe("what a finished forecast run says", () => {
  it("reports how many products the run wrote", () => {
    expect(forecastRunMessage(30)).toBe("30 products updated");
  });

  it("does not say '1 products'", () => {
    expect(forecastRunMessage(1)).toBe("1 product updated");
  });

  it("still confirms the run when the count is missing", () => {
    // An older deployment, or a body that failed to parse: silence is the one
    // thing this must not fall back to.
    expect(forecastRunMessage(undefined)).toBe("Forecast run");
  });

  it("confirms a run that produced nothing, rather than saying nothing", () => {
    expect(forecastRunMessage(0)).toBe("0 products updated");
  });
});
