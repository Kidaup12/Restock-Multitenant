import { describe, expect, it, vi } from "vitest";

const flags = vi.hoisted(() => ({ value: {} as Record<string, unknown> | null }));
vi.mock("@wezesha/db", async () => ({
  ...(await import("../../../packages/db/src/inbound")),
  ...(await import("../../../packages/db/src/notify-prefs")),
  BUYABLE_PRODUCT_WHERE: {},
  CUSTOMER_TENANTS_WHERE: {},
  roleOf: () => "sells",
  prismaService: {
    tenantConfig: { findFirst: async () => ({ featureFlags: flags.value }) },
    tenant: { findUnique: async () => ({ timezone: "Africa/Nairobi", name: "Shop", tenantConfig: null }) },
    membership: { findMany: async () => [{ notifyPrefs: null, user: { email: "owner@example.com" } }] },
  },
}));
vi.mock("../src/imports-watch", async (orig) => ({
  ...(await orig<typeof import("../src/imports-watch")>()),
  buildImportsWatch: vi.fn(async () => null),
}));

const { isImportsWatchDay } = await import("../src/imports-watch");
const { renderImportsWatchEmail } = await import("../src/imports-watch-email");
const { sendImportsWatch } = await import("../src/crons");

const watch = {
  tenantName: "Shop <b>", currency: "USD", dateLabel: "5 Nov 2026", leadDays: 14, watchedCount: 3, urgentCount: 1, attentionCount: 2,
  bestsellers: [], criticals: [{ title: "Serum <script>", sku: "S", abc: "A" as const, runRate: 1.5, orderQty: 12, orderCostKes: 6000, shops: 2, warehouse: 0, enRoute: 0, total: 2, daysLeft: 1 }],
  criticalsCount: 1, criticalsBudgetKes: 6000, oosHigh: [], oosHighCount: 0, oosHighBudgetKes: 0, oosLow: [], oosLowCount: 1, oosLowBudgetKes: 0,
  others: [], othersCount: 0, othersBudgetKes: 0, totalBudgetKes: 6000, totalOrderLines: 1,
};

describe("imports watch", () => {
  it("sends every other day on the shop's own calendar", () => {
    // 5 Nov 2026 is day 309 (odd), 6 Nov is 310 (even) — in Nairobi.
    expect(isImportsWatchDay(new Date("2026-11-05T05:00:00Z"), "Africa/Nairobi")).toBe(false);
    expect(isImportsWatchDay(new Date("2026-11-06T05:00:00Z"), "Africa/Nairobi")).toBe(true);
    // 22:30 UTC on 5 Nov is already 6 Nov in Nairobi.
    expect(isImportsWatchDay(new Date("2026-11-05T22:30:00Z"), "Africa/Nairobi")).toBe(true);
  });

  it("renders in the shop's currency and escapes product and shop names", () => {
    const { html, subject, text } = renderImportsWatchEmail(watch);
    expect(html).toContain("USD 6k");
    expect(html).not.toContain("KES");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Serum &lt;script&gt;");
    expect(subject).toContain("1 urgent");
    expect(text).toContain("CRITICAL REORDERS (1 · USD 6k)");
  });

  it("is off unless the shop has switched it on", async () => {
    const send = vi.fn();
    flags.value = {};
    expect(await sendImportsWatch("t", send, { force: true })).toBe(false);
    flags.value = { imports_watch: true };
    // Switched on, but nothing to watch → still nothing sent.
    expect(await sendImportsWatch("t", send, { force: true })).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});
