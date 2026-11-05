import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

/**
 * Plain-English wording for the night's stock recommendations — one Claude call
 * per shop.
 *
 * The rules (@wezesha/forecast recommendations.ts) have already decided every
 * action and number. The model only re-says them for a shop owner and suggests
 * a short offer idea. It is sent the product title, category and the rule's
 * numbers — no customer data — and its answer is used only if every figure it
 * writes appears in what it was given. Anything else, a missing key, or a
 * failed call falls back to the rule's own sentence: wording is optional,
 * numbers are not.
 */

export const WORDING_MODEL = "claude-haiku-5-5";
/** Upper bound on items worded per shop per night. */
export const MAX_WORDED_ITEMS = 20;
/** Claude Haiku 5.5 list price per million tokens (prompts up to 100K). */
const USD_PER_M_INPUT = 0.1;
const USD_PER_M_OUTPUT = 0.5;
const MAX_OUTPUT_TOKENS = 4000;
/** The most one call can cost: a generous input allowance plus every output
 *  token it may write. A call is only made if this still fits the budget. */
export const MAX_CALL_COST_USD = (20_000 * USD_PER_M_INPUT + MAX_OUTPUT_TOKENS * USD_PER_M_OUTPUT) / 1_000_000;

export function callCostUsd(usage: { input_tokens: number; output_tokens: number }): number {
  return (usage.input_tokens * USD_PER_M_INPUT + usage.output_tokens * USD_PER_M_OUTPUT) / 1_000_000;
}

export type WordingUsage = { costUsd: number; inputTokens: number; outputTokens: number };

export type WordingItem = {
  key: string;
  title: string;
  category: string | null;
  action: string;
  reason: string;
  numbers: Record<string, string | number | null>;
};

export type Wording = { reason: string; idea: string };

const Output = z.object({
  items: z.array(z.object({ key: z.string(), reason: z.string(), idea: z.string() })),
});

const SYSTEM = `You write short notes for the owner of a small beauty and fragrance shop in Kenya.
Each item is a product that is not selling and the action our rules chose for it.
For every item return:
- reason: one plain sentence (max 30 words) saying what is happening and what to do. Keep the action the same.
- idea: one short, practical offer idea the shop could run (max 20 words), e.g. a bundle, a gift-with-purchase, a display or WhatsApp promotion.
Use only the numbers given for that item. Do not invent prices, percentages, quantities or dates. No hashtags, no emojis.`;

/** Every number a sentence contains, normalised ("1,200" → "1200"). */
function numbersIn(text: string): string[] {
  return (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, "").replace(/\.0+$/, ""));
}

/** True when every figure in `out` comes from the item's own inputs. */
export function usesOnlyGivenNumbers(out: string, item: WordingItem): boolean {
  const allowed = new Set([
    ...numbersIn(item.reason),
    ...numbersIn(item.title),
    ...Object.values(item.numbers).flatMap((v) => (v == null ? [] : numbersIn(String(v)))),
  ]);
  return numbersIn(out).every((n) => allowed.has(n));
}

export function acceptWording(item: WordingItem, w: Wording | undefined): Wording | null {
  if (!w) return null;
  const reason = w.reason.trim();
  const idea = w.idea.trim();
  if (!reason || reason.length > 240 || idea.length > 160) return null;
  if (!usesOnlyGivenNumbers(reason, item) || !usesOnlyGivenNumbers(idea, item)) return null;
  return { reason, idea };
}

export async function wordRecommendations(
  items: WordingItem[],
  {
    client,
    remainingUsd = Infinity,
    onUsage,
  }: {
    client?: Pick<Anthropic, "messages">;
    /** What this workspace may still spend this month; no call when one might not fit. */
    remainingUsd?: number;
    /** Told what the call actually cost, to record against the workspace. */
    onUsage?: (usage: WordingUsage) => Promise<void>;
  } = {}
): Promise<Map<string, Wording>> {
  const out = new Map<string, Wording>();
  const batch = items.slice(0, MAX_WORDED_ITEMS);
  if (batch.length === 0) return out;
  if (!client && !process.env.ANTHROPIC_API_KEY) return out; // wording is optional
  if (remainingUsd < MAX_CALL_COST_USD) {
    console.log("worker: recommendation wording skipped — monthly AI budget reached");
    return out;
  }
  const api = client ?? new Anthropic();
  try {
    const response = await api.messages.parse({
      model: WORDING_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: SYSTEM,
      output_config: { effort: "low", format: zodOutputFormat(Output) },
      messages: [
        {
          role: "user",
          content: JSON.stringify(
            batch.map((i) => ({ key: i.key, product: i.title, category: i.category, action: i.action, rule: i.reason, numbers: i.numbers }))
          ),
        },
      ],
    });
    const cost = callCostUsd(response.usage);
    console.log(
      `worker: recommendation wording — ${batch.length} items, ${response.usage.input_tokens} in / ${response.usage.output_tokens} out tokens, ${cost.toFixed(5)}`
    );
    await onUsage?.({ costUsd: cost, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens });
    const byKey = new Map((response.parsed_output?.items ?? []).map((w) => [w.key, w]));
    for (const item of batch) {
      const ok = acceptWording(item, byKey.get(item.key));
      if (ok) out.set(item.key, ok);
    }
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      console.error(`worker: recommendation wording failed (${err.status}) — using rule wording`, err.message);
    } else {
      console.error("worker: recommendation wording failed — using rule wording", err);
    }
  }
  return out;
}
