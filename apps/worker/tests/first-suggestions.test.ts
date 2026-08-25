import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmailMessage } from "../src/email";

/**
 * The welcome email, and the four ways it must decline to send.
 *
 * The one that matters most is the cutoff. Every workspace on production when
 * this was written was between eighteen and twenty-eight days old, so a naive
 * "was this shop created recently" rule would have greeted all of them at once
 * on the first run after deploy — an email announcing first value to shops that
 * reached it weeks earlier.
 */

const runnable = /localhost|127\.0\.0\.1/.test(process.env.SERVICE_DATABASE_URL ?? "");

const SLUGS = {
  fresh: "first-suggestions-fresh",
  old: "first-suggestions-old",
  empty: "first-suggestions-empty",
};
const OWNER_EMAIL = "first-suggestions-owner@wezesha.test";

let prismaService: typeof import("@wezesha/db").prismaService;
let mod: typeof import("../src/first-suggestions");
let freshId: string;
let oldId: string;
let emptyId: string;

/** Mirrors the real sender: it is sendEmail that writes the ledger row the
 *  once-only guard reads, so a fake that skips it would leave the guard inert
 *  and this suite would pass while production sent twice. */
const collect = () => {
  const sent: EmailMessage[] = [];
  const send = async (m: EmailMessage) => {
    sent.push(m);
    await prismaService.emailLog.create({
      data: { tenantId: m.tenantId ?? null, to: m.to, subject: m.subject, kind: m.kind ?? null, status: "sent" },
    });
  };
  return { sent, send };
};

describe.skipIf(!runnable)("first-suggestions email", () => {
  beforeAll(async () => {
    ({ prismaService } = await import("@wezesha/db"));
    mod = await import("../src/first-suggestions");

    await prismaService.tenant.deleteMany({ where: { slug: { in: Object.values(SLUGS) } } });
    await prismaService.user.deleteMany({ where: { email: OWNER_EMAIL } });
    const user = await prismaService.user.create({
      data: { id: "first-suggestions-owner", name: "First Owner", email: OWNER_EMAIL },
    });

    const after = new Date(mod.FIRST_SUGGESTIONS_FROM.getTime() + 86_400_000);
    const before = new Date(mod.FIRST_SUGGESTIONS_FROM.getTime() - 86_400_000);

    const make = async (slug: string, createdAt: Date) =>
      prismaService.tenant.create({
        data: {
          name: slug,
          slug,
          createdAt,
          memberships: { create: { userId: user.id, role: "OWNER" } },
        },
      });

    freshId = (await make(SLUGS.fresh, after)).id;
    oldId = (await make(SLUGS.old, before)).id;
    emptyId = (await make(SLUGS.empty, after)).id;

    // A product and a prediction worth buying, for the two that should qualify.
    for (const tenantId of [freshId, oldId]) {
      const product = await prismaService.product.create({
        data: { tenantId, sku: `SKU-${tenantId.slice(0, 6)}`, title: "Something", costKes: 100 },
      });
      await prismaService.prediction.create({
        data: {
          tenantId,
          productId: product.id,
          runDate: new Date(),
          layer1Forecast30d: 10,
          layer1Confidence: 1,
          layer2Adjustment: 0,
          finalForecast30d: 10,
          daysUntilStockout: 5,
          recommendedQty: 12,
          safetyStock: 1,
          reorderPoint: 2,
          confidence: 1,
          reasoning: "test",
          urgency: "high",
          signals: "",
        },
      });
    }
  }, 120_000);

  afterAll(async () => {
    await prismaService.emailLog.deleteMany({ where: { to: OWNER_EMAIL } });
    await prismaService.tenant.deleteMany({ where: { slug: { in: Object.values(SLUGS) } } });
    await prismaService.user.deleteMany({ where: { email: OWNER_EMAIL } });
    await prismaService.$disconnect();
  });

  it("greets a workspace that reaches its first buy list", async () => {
    const { sent, send } = collect();
    await expect(mod.sendFirstSuggestions(freshId, send)).resolves.toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(OWNER_EMAIL);
    expect(sent[0]!.kind).toBe("first_suggestions");
    // The count comes from the data, not from a literal in the copy.
    expect(sent[0]!.text).toContain("1 product needs restocking");
  });

  it("never sends twice, and the ledger is what remembers", async () => {
    const { sent, send } = collect();
    await expect(mod.sendFirstSuggestions(freshId, send)).resolves.toBe("already_sent");
    expect(sent).toHaveLength(0);

    // Prove the ledger is doing it: clear the row and it would send again.
    await prismaService.emailLog.deleteMany({
      where: { tenantId: freshId, kind: "first_suggestions" },
    });
    const retry = collect();
    await expect(mod.sendFirstSuggestions(freshId, retry.send)).resolves.toBe("sent");
    expect(retry.sent).toHaveLength(1);
  });

  it("leaves a workspace older than the email alone", async () => {
    const { sent, send } = collect();
    await expect(mod.sendFirstSuggestions(oldId, send)).resolves.toBe(
      "workspace_predates_the_email"
    );
    expect(sent, "an established shop was greeted as though it were new").toHaveLength(0);
  });

  it("stays quiet when the run recommends nothing", async () => {
    const { sent, send } = collect();
    await expect(mod.sendFirstSuggestions(emptyId, send)).resolves.toBe("nothing_to_suggest");
    expect(sent).toHaveLength(0);
  });

  it("declines for a workspace that no longer exists", async () => {
    const { sent, send } = collect();
    await expect(mod.sendFirstSuggestions("no-such-tenant", send)).resolves.toBe("unknown_tenant");
    expect(sent).toHaveLength(0);
  });

  it("skips a member who switched this one off", async () => {
    await prismaService.emailLog.deleteMany({
      where: { tenantId: freshId, kind: "first_suggestions" },
    });
    const membership = await prismaService.membership.findFirstOrThrow({
      where: { tenantId: freshId },
      select: { id: true },
    });
    await prismaService.membership.update({
      where: { id: membership.id },
      data: { notifyPrefs: { first_suggestions: false } },
    });
    const { sent, send } = collect();
    await expect(mod.sendFirstSuggestions(freshId, send)).resolves.toBe("no_recipients");
    expect(sent).toHaveLength(0);
  });
});
