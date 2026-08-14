import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sendEmail } from "../lib/email";

/**
 * The send is not allowed to lie about itself.
 *
 * Three properties: a production deployment with no provider key refuses the
 * send instead of returning as though it went out; every attempt leaves one
 * EmailLog row saying what happened, to whom and when; and outside production
 * the console fallback still resolves, so local dev and the existing seam suite
 * are untouched.
 *
 * The purchase order is why it matters. send-po claims the PO (status "sent",
 * an ETA written, "on order" quantities moved) before it mails the supplier and
 * rolls that claim back only on a throw — so a silent success is an order the
 * shop believes was placed and no supplier ever received.
 */

function okFetch(status = 201, id = "resend-message-id") {
  return vi.fn(async () => ({
    ok: status < 400,
    status,
    json: async () => ({ id }),
    text: async () => "",
  })) as unknown as typeof fetch;
}

const KEY = "test-resend-key";
const FROM = "Wezesha Restock <no-reply@wezesha.test>";

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const SLUG = "email-log-tenant";
const SUPPLIER_EMAIL = "orders@email-log.example";

describe.skipIf(!runnable)("email log + missing-key behaviour (local db)", () => {
  let prismaService: typeof import("@wezesha/db").prismaService;
  let sendPoToSupplier: typeof import("../lib/po/send-po").sendPoToSupplier;
  let tenantId: string;
  let supplierId: string;

  const original = { key: process.env.RESEND_API_KEY, from: process.env.EMAIL_FROM };

  beforeAll(async () => {
    ({ prismaService } = await import("@wezesha/db"));
    ({ sendPoToSupplier } = await import("../lib/po/send-po"));

    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    const tenant = await prismaService.tenant.create({ data: { name: "Email Log", slug: SLUG } });
    tenantId = tenant.id;
    const supplier = await prismaService.supplier.create({
      data: { tenantId, name: "Log Supplier", email: SUPPLIER_EMAIL, moq: 1, leadTimeAvgDays: 7 },
    });
    supplierId = supplier.id;
  }, 30_000);

  afterAll(async () => {
    await prismaService.emailLog.deleteMany({ where: { tenantId } });
    await prismaService.tenant.deleteMany({ where: { id: tenantId } });
    await prismaService.$disconnect();
  }, 30_000);

  beforeEach(async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
    vi.unstubAllEnvs();
    await prismaService.emailLog.deleteMany({ where: { tenantId } });
  });

  afterEach(() => {
    process.env.RESEND_API_KEY = original.key;
    process.env.EMAIL_FROM = original.from;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** A draft PO with one line, ready to send. */
  async function draftPo(tag: string): Promise<string> {
    const product = await prismaService.product.create({
      data: { tenantId, supplierId, sku: `LOG-${tag}`, title: `Log SKU ${tag}`, costKes: 100 },
    });
    const po = await prismaService.purchaseOrder.create({
      data: {
        tenantId,
        supplierId,
        poNumber: `PO-LOG-${tag}`,
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

  it("refuses to send in production when the provider key is missing", async () => {
    vi.stubEnv("NODE_ENV", "production");

    await expect(
      sendEmail({ to: "owner@shop.test", subject: "Your code", text: "123456" }, okFetch()),
    ).rejects.toThrow(/RESEND_API_KEY/);
  });

  it("still resolves outside production so local dev keeps working", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchMock = okFetch();

    await expect(
      sendEmail({ to: "owner@shop.test", subject: "Your code", text: "123456" }, fetchMock),
    ).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no RESEND_API_KEY"));
  });

  it("writes exactly one 'sent' row after a successful send", async () => {
    process.env.RESEND_API_KEY = KEY;
    process.env.EMAIL_FROM = FROM;

    await sendEmail(
      {
        to: SUPPLIER_EMAIL,
        subject: "Purchase order PO-1001",
        text: "Plain-text PO",
        html: "<h1>PO-1001</h1>",
        tenantId,
        kind: "purchase_order",
      },
      okFetch(),
    );

    const rows = await prismaService.emailLog.findMany({ where: { tenantId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("sent");
    expect(rows[0]!.to).toBe(SUPPLIER_EMAIL);
    expect(rows[0]!.subject).toBe("Purchase order PO-1001");
    expect(rows[0]!.kind).toBe("purchase_order");
    expect(rows[0]!.providerId).toBe("resend-message-id");
    expect(rows[0]!.error).toBeNull();
    expect(rows[0]!.createdAt).toBeInstanceOf(Date);
  });

  it("records a failed send with the provider's reason, and still throws", async () => {
    process.env.RESEND_API_KEY = KEY;
    process.env.EMAIL_FROM = FROM;

    await expect(
      sendEmail({ to: SUPPLIER_EMAIL, subject: "Hi", text: "body", tenantId }, okFetch(422)),
    ).rejects.toThrow(/Resend send failed \(422\)/);

    const rows = await prismaService.emailLog.findMany({ where: { tenantId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.error).toMatch(/422/);
  });

  it("records the console fallback as skipped, not sent", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.spyOn(console, "log").mockImplementation(() => {});

    await sendEmail({ to: SUPPLIER_EMAIL, subject: "Hi", text: "body", tenantId }, okFetch());

    const rows = await prismaService.emailLog.findMany({ where: { tenantId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("skipped");
    expect(rows[0]!.providerId).toBeNull();
  });

  it("never stores the message body", async () => {
    process.env.RESEND_API_KEY = KEY;
    process.env.EMAIL_FROM = FROM;
    const secret = "Unit cost KES 1,250 — supplier margin";

    await sendEmail(
      { to: SUPPLIER_EMAIL, subject: "Purchase order PO-1002", text: secret, html: secret, tenantId },
      okFetch(),
    );

    const rows = await prismaService.emailLog.findMany({ where: { tenantId } });
    expect(JSON.stringify(rows)).not.toContain("1,250");
  });

  it("a logging failure never fails an otherwise successful send", async () => {
    process.env.RESEND_API_KEY = KEY;
    process.env.EMAIL_FROM = FROM;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Break the ledger write the way a database outage would.
    vi.spyOn(prismaService.emailLog, "create").mockRejectedValue(new Error("db down"));
    const fetchMock = okFetch();

    await expect(
      sendEmail({ to: SUPPLIER_EMAIL, subject: "Hi", text: "body", tenantId }, fetchMock),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rolls the purchase order back to draft when production has no key", async () => {
    // send-po is untouched by this change: its existing try/catch already hands
    // the claim back on a throw. It was inert only because the seam never threw.
    vi.stubEnv("NODE_ENV", "production");
    const poId = await draftPo("prod");

    await expect(sendPoToSupplier(tenantId, poId)).rejects.toThrow(/RESEND_API_KEY/);

    const po = await prismaService.purchaseOrder.findUnique({
      where: { id: poId },
      select: { status: true, sentAt: true, expectedAt: true },
    });
    expect(po?.status).toBe("draft");
    expect(po?.sentAt).toBeNull();
    expect(po?.expectedAt).toBeNull();
  }, 30_000);
});
