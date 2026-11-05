import { describe, expect, it, vi } from "vitest";
import { acceptWording, MAX_CALL_COST_USD, usesOnlyGivenNumbers, wordRecommendations, type WordingItem } from "../src/recommendation-wording";

const item: WordingItem = {
  key: "p|discount",
  title: "Lotion 236ml",
  category: "Body",
  action: "discount",
  reason: "12 on the shelf and no sale in 100 days. Try 20% off (1,880 instead of 2,350) to free the cash.",
  numbers: { pct: 20, newPriceKes: 1880, priceKes: 2350 },
};

describe("monthly AI budget", () => {
  it("makes no call once a workspace has less left than one call could cost", async () => {
    const parse = vi.fn();
    const out = await wordRecommendations([item], { client: { messages: { parse } } as never, remainingUsd: 0.001 });
    expect(out.size).toBe(0);
    expect(parse).not.toHaveBeenCalled();
  });
  it("reports what a call cost at Haiku prices", async () => {
    const parse = vi.fn(async () => ({ usage: { input_tokens: 2_000, output_tokens: 1_000 }, parsed_output: { items: [] } }));
    const spent: number[] = [];
    await wordRecommendations([item], { client: { messages: { parse } } as never, onUsage: async (u) => { spent.push(u.costUsd); } });
    expect(spent[0]).toBeCloseTo(0.0007); // 2k × $0.10/M + 1k × $0.50/M
  });
  it("one call can never exceed a cent, so $5 is ~2,000 nights of wording", () => {
    expect(MAX_CALL_COST_USD).toBeLessThan(0.01);
  });
});

describe("recommendation wording guard", () => {
  it("accepts wording that only uses the rule's numbers (commas and all)", () => {
    expect(usesOnlyGivenNumbers("Take 20% off — 1,880 instead of 2,350 — to clear 12 bottles.", item)).toBe(true);
    expect(acceptWording(item, { reason: "No sale in 100 days: try 20% off.", idea: "Pair with a body mist on WhatsApp." })).not.toBeNull();
  });
  it("rejects wording that invents a number", () => {
    expect(acceptWording(item, { reason: "Try 35% off this week.", idea: "Bundle it." })).toBeNull();
    expect(acceptWording(item, { reason: "Try 20% off.", idea: "Sell 3 for 5,000." })).toBeNull();
  });
  it("rejects empty or overlong wording", () => {
    expect(acceptWording(item, { reason: "  ", idea: "" })).toBeNull();
    expect(acceptWording(item, { reason: "x".repeat(300), idea: "" })).toBeNull();
  });
  it("without a key or a client, returns nothing and makes no call", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    expect((await wordRecommendations([item])).size).toBe(0);
    if (prev) process.env.ANTHROPIC_API_KEY = prev;
  });
  it("keeps only items that pass the guard, and survives a failed call", async () => {
    const parse = vi.fn(async () => ({
      usage: { input_tokens: 10, output_tokens: 10 },
      parsed_output: { items: [{ key: "p|discount", reason: "Try 20% off to clear it.", idea: "Gift wrap it." }, { key: "other", reason: "x", idea: "y" }] },
    }));
    const client = { messages: { parse } } as never;
    const out = await wordRecommendations([item], { client });
    expect([...out.keys()]).toEqual(["p|discount"]);
    const failing = { messages: { parse: vi.fn(async () => { throw new Error("down"); }) } } as never;
    expect((await wordRecommendations([item], { client: failing })).size).toBe(0);
  });
});
