import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SpikeSuggestions } from "../app/(shell)/settings/signals/spike-suggestions";

vi.mock("../app/(shell)/settings/signals/actions", () => ({ dismissSpike: vi.fn(), logSpikeAsPromo: vi.fn() }));
const suggestions = [{ productId: "p1", sku: "SER", title: "Serum", dayKey: "2026-10-04", dayLabel: "4 Oct 2026",
  quantity: 7, baseline: 1, multiple: 7, kind: "possible_bulk" as const, threshold: 6, inProgress: true }];

describe("visible sales review", () => {
  it("shows quantity evidence and suspicion, with accurate review choices", () => {
    const html = renderToStaticMarkup(<SpikeSuggestions suggestions={suggestions} canManage />);
    expect(html).toContain("Possible bulk purchase");
    expect(html).toContain("7 units across all channels");
    expect(html).toContain("today so far");
    expect(html).toContain("do not identify a single buyer");
    expect(html).toContain("Record promotion");
    expect(html).toContain("Dismiss flag");
    expect(html).toContain("/products/p1");
    expect(html).toContain("/sales#unusual-sales");
    expect(html).toContain("does not change sales or forecast demand");
  });
  it("lets read-only members see flags without presenting management controls", () => {
    const html = renderToStaticMarkup(<SpikeSuggestions suggestions={suggestions} canManage={false} />);
    expect(html).toContain("Possible bulk purchase");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("/settings/ordering-strategy");
  });
});
