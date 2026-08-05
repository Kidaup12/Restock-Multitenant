import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Two admins, two tabs, or one impatient double-click on "send to supplier".
 *
 * The send used to read the PO, email the supplier, and only then mark it sent
 * — so both callers could read "draft" before either write landed, and the
 * supplier received the same order twice while one PO showed as sent. That is a
 * real order placed twice, not a cosmetic bug.
 *
 * Emails are counted here rather than merely suppressed: without RESEND_API_KEY
 * the real sender only logs and never throws, so a duplicate would be invisible.
 */

const sent: string[] = [];
vi.mock("../lib/email", () => ({
  sendEmail: vi.fn(async ({ to }: { to: string }) => {
    sent.push(to);
  }),
}));

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const SLUG = "po-send-race-tenant";
const ROUNDS = 3;
const SUPPLIER_EMAIL = "orders@send-race.example";

describe.skipIf(!runnable)("purchase-order send race (local db)", () => {
  let prismaService: typeof import("@wezesha/db").prismaService;
  let sendPoToSupplier: typeof import("../lib/po/send-po").sendPoToSupplier;
  let tenantId: string;
  let supplierId: string;

  beforeAll(async () => {
    ({ prismaService } = await import("@wezesha/db"));
    ({ sendPoToSupplier } = await import("../lib/po/send-po"));

    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    const tenant = await prismaService.tenant.create({ data: { name: "Send Race", slug: SLUG } });
    tenantId = tenant.id;
    const supplier = await prismaService.supplier.create({
      data: { tenantId, name: "Race Supplier", email: SUPPLIER_EMAIL, moq: 1, leadTimeAvgDays: 7 },
    });
    supplierId = supplier.id;
  }, 30_000);

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { id: tenantId } });
    await prismaService.$disconnect();
  }, 30_000);

  /** A draft PO with one line, ready to send. */
  async function draftPo(tag: string): Promise<string> {
    const product = await prismaService.product.create({
      data: { tenantId, supplierId, sku: `SEND-${tag}`, title: `Send SKU ${tag}`, costKes: 100 },
    });
    const po = await prismaService.purchaseOrder.create({
      data: {
        tenantId,
        supplierId,
        poNumber: `PO-SEND-${tag}`,
        status: "draft",
        subtotalKes: 500,
        lines: {
          create: [
            {
              tenantId,
              productId: product.id,
              sku: product.sku,
              title: product.title,
              quantity: 5,
              unitCostKes: 100,
              lineTotalKes: 500,
            },
          ],
        },
      },
      select: { id: true },
    });
    return po.id;
  }

  it("emails the supplier once however many callers press send together", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      sent.length = 0;
      const poId = await draftPo(`r${round}`);

      // Genuinely concurrent: two pooled connections, two real transactions.
      const results = await Promise.all([
        sendPoToSupplier(tenantId, poId),
        sendPoToSupplier(tenantId, poId),
      ]);

      // The invariant, not a particular winner: one send, one email.
      expect(results.filter((r) => r.ok), `round ${round}`).toHaveLength(1);
      expect(sent, `round ${round}`).toEqual([SUPPLIER_EMAIL]);

      const loser = results.find((r) => !r.ok);
      expect(loser && "reason" in loser ? loser.reason : null).toBe("not_sendable");

      const po = await prismaService.purchaseOrder.findUnique({
        where: { id: poId },
        select: { status: true, sentAt: true },
      });
      expect(po?.status).toBe("sent");
      expect(po?.sentAt).toBeTruthy();
    }
  }, 60_000);

  it("hands the PO back when the email fails, so it can be retried", async () => {
    const { sendEmail } = await import("../lib/email");
    const poId = await draftPo("boom");
    sent.length = 0;
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error("provider down"));

    await expect(sendPoToSupplier(tenantId, poId)).rejects.toThrow("provider down");

    // A PO that says "sent" to a supplier who never heard from us is worse than
    // one the owner can send again.
    const po = await prismaService.purchaseOrder.findUnique({
      where: { id: poId },
      select: { status: true, sentAt: true },
    });
    expect(po?.status).toBe("draft");
    expect(po?.sentAt).toBeNull();
  }, 30_000);
});
