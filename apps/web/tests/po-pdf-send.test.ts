import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { EmailMessage } from "../lib/email";

/**
 * The supplier's copy of the purchase order travels as a PDF attachment, not
 * just as the email body. Two things are checked against a real database:
 * the send carries exactly one PDF, and a PDF that fails to generate never
 * leaves a purchase order marked sent with nothing delivered.
 */

const sends: EmailMessage[] = [];
vi.mock("../lib/email", () => ({
  sendEmail: vi.fn(async (message: EmailMessage) => {
    sends.push(message);
  }),
}));

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const SLUG = "po-pdf-send-tenant";
const SUPPLIER_EMAIL = "orders@pdf-send.example";

describe.skipIf(!runnable)("purchase order sent as a PDF (local db)", () => {
  let prismaService: typeof import("@wezesha/db").prismaService;
  let sendPoToSupplier: typeof import("../lib/po/send-po").sendPoToSupplier;
  let tenantId: string;
  let supplierId: string;

  beforeAll(async () => {
    ({ prismaService } = await import("@wezesha/db"));
    ({ sendPoToSupplier } = await import("../lib/po/send-po"));

    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    const tenant = await prismaService.tenant.create({ data: { name: "PDF Send", slug: SLUG } });
    tenantId = tenant.id;
    const supplier = await prismaService.supplier.create({
      data: { tenantId, name: "PDF Supplier", email: SUPPLIER_EMAIL, moq: 1, leadTimeAvgDays: 5 },
    });
    supplierId = supplier.id;
  }, 30_000);

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { id: tenantId } });
    await prismaService.$disconnect();
  }, 30_000);

  /** A draft PO with two lines, ready to send. */
  async function draftPo(tag: string): Promise<string> {
    const product = await prismaService.product.create({
      data: { tenantId, supplierId, sku: `PDF-${tag}`, title: `PDF SKU ${tag}`, costKes: 250 },
    });
    const po = await prismaService.purchaseOrder.create({
      data: {
        tenantId,
        supplierId,
        poNumber: `PO-PDF-${tag}`,
        status: "draft",
        subtotalKes: 2500,
        lines: {
          create: [
            {
              tenantId,
              productId: product.id,
              sku: product.sku,
              title: product.title,
              quantity: 10,
              unitCostKes: 250,
              lineTotalKes: 2500,
            },
          ],
        },
      },
      select: { id: true },
    });
    return po.id;
  }

  it("attaches exactly one PDF to the supplier's email", async () => {
    sends.length = 0;
    const poId = await draftPo("one");

    expect(await sendPoToSupplier(tenantId, poId)).toMatchObject({ ok: true });

    expect(sends).toHaveLength(1);
    const attachments = sends[0]!.attachments ?? [];
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.filename).toBe("PO-PDF-one.pdf");
    expect(Buffer.from(attachments[0]!.content).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  }, 30_000);

  it("leaves the purchase order in draft when the PDF cannot be generated", async () => {
    const poId = await draftPo("boom");
    sends.length = 0;

    // Break generation the way a malformed document would, and check the claim
    // on the PO never outlives the thing it was claiming for.
    vi.resetModules();
    vi.doMock("../lib/po/po-pdf", () => ({
      poPdfBytes: async () => {
        throw new Error("pdf render failed");
      },
      poPdfFilename: () => "broken.pdf",
    }));
    const { sendPoToSupplier: sendWithBrokenPdf } = await import("../lib/po/send-po");

    await expect(sendWithBrokenPdf(tenantId, poId)).rejects.toThrow("pdf render failed");

    vi.doUnmock("../lib/po/po-pdf");
    vi.resetModules();

    expect(sends, "no email may go out without the attachment").toHaveLength(0);
    const po = await prismaService.purchaseOrder.findUnique({
      where: { id: poId },
      select: { status: true, sentAt: true, expectedAt: true },
    });
    expect(po?.status).toBe("draft");
    expect(po?.sentAt).toBeNull();
    expect(po?.expectedAt).toBeNull();
  }, 30_000);
});
