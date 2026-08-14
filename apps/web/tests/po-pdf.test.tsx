import { inflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { sendEmail } from "../lib/email";
import { PoDocument } from "../lib/po/po-document";
import { poAmount, type PoDocumentData } from "../lib/po/po-model";
import { poPdfBytes, poPdfFilename } from "../lib/po/po-pdf";

/**
 * The PDF attachment is a second renderer of the same document, and a second
 * renderer is how one number acquires two values. So the numbers are compared
 * as *rendered output*: the strings drawn into the PDF's content streams
 * against the strings the print view puts on the page. Asserting that both were
 * handed the same PoDocumentData would prove they were handed it, not that
 * either printed it.
 *
 * The fixture's subtotal deliberately does not equal the sum of its line totals
 * (18,250 against 18,285). A renderer that adds the lines up itself instead of
 * printing the document's subtotal disagrees with the other one and fails here.
 */

const CURRENCY = "KES";

const doc: PoDocumentData = {
  poNumber: "PO-2087",
  status: "sent",
  createdAt: new Date("2026-08-01T09:00:00Z"),
  sentAt: new Date("2026-08-03T09:00:00Z"),
  expectedAt: new Date("2026-08-17T09:00:00Z"),
  currency: CURRENCY,
  shop: { name: "Riverside Grocers" },
  supplier: { name: "Highland Wholesale", email: "orders@highland.example", country: "KE" },
  lines: [
    { sku: "TEA-250", title: "Tea & Spice 250g", quantity: 24, unitCostKes: 187, lineTotalKes: 4488 },
    { sku: "OIL-1L", title: "Sunflower oil 1L", quantity: 6, unitCostKes: 1249.5, lineTotalKes: 7497 },
    { sku: "RICE-5", title: "Basmati rice 5kg", quantity: 3, unitCostKes: 2100, lineTotalKes: 6300 },
  ],
  subtotalKes: 18_250,
  totalUnits: 33,
  createdByName: "Store manager",
};

/**
 * WinAnsi and latin1 agree everywhere except 0x80–0x9F, which is where the cost
 * mask's bullet and the em dash live. Undefined slots stay as they decode.
 */
const WINANSI_HIGH = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";

function fromWinAnsi(bytes: Buffer): string {
  return [...bytes]
    .map((b) => (b >= 0x80 && b <= 0x9f ? WINANSI_HIGH[b - 0x80]! : String.fromCharCode(b)))
    .join("");
}

/**
 * The strings actually drawn on the page, in order. pdf-lib flate-compresses
 * its content streams and writes text as hex-encoded WinAnsi, so this inflates
 * every stream and decodes each text-showing operand — one entry per drawText.
 */
function pdfCells(bytes: Uint8Array): string[] {
  const buf = Buffer.from(bytes);
  const cells: string[] = [];
  let at = 0;
  for (;;) {
    const start = buf.indexOf("stream", at);
    if (start < 0) break;
    let from = start + "stream".length;
    if (buf[from] === 0x0d) from++;
    if (buf[from] === 0x0a) from++;
    const end = buf.indexOf("endstream", from);
    if (end < 0) break;
    at = end + "endstream".length;
    let drawn: string;
    try {
      drawn = inflateSync(buf.subarray(from, end)).toString("latin1");
    } catch {
      continue; // not a flate stream (cross-reference tables, embedded data)
    }
    for (const [, hex] of drawn.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)) {
      cells.push(fromWinAnsi(Buffer.from(hex, "hex")));
    }
  }
  return cells;
}

/** The same for the print view: one entry per rendered element's text. */
function htmlCells(data: PoDocumentData): string[] {
  return renderToStaticMarkup(<PoDocument doc={data} />)
    .split(/<[^>]+>/)
    .map((cell) =>
      cell
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .trim()
    )
    .filter(Boolean);
}

/** The `count` cells following the last occurrence of `anchor`. */
function after(cells: string[], anchor: string, count: number): string[] {
  const at = cells.lastIndexOf(anchor);
  expect(at, `"${anchor}" is not in the rendered output`).toBeGreaterThanOrEqual(0);
  return cells.slice(at + 1, at + 1 + count);
}

describe("purchase-order PDF", () => {
  it("prints the same line and grand totals as the print view", async () => {
    const fromPdf = pdfCells(await poPdfBytes(doc));
    const fromHtml = htmlCells(doc);

    // Title, quantity, unit cost, line total — the whole row, cell for cell.
    for (const line of doc.lines) {
      expect(after(fromPdf, line.sku, 4), line.sku).toEqual(after(fromHtml, line.sku, 4));
    }

    const label = `Total (${CURRENCY})`;
    expect(after(fromPdf, label, 1)).toEqual(after(fromHtml, label, 1));
    // Anchored to the document too, so two renderers agreeing on a wrong number
    // is still a failure.
    expect(after(fromPdf, label, 1)).toEqual([poAmount(doc.subtotalKes)]);
    expect(after(fromPdf, label, 1)).not.toEqual([poAmount(18_285)]);
  });

  it("carries every line onto the page when the order runs past one", async () => {
    const long: PoDocumentData = {
      ...doc,
      lines: Array.from({ length: 90 }, (_, i) => ({
        sku: `BULK-${String(i).padStart(3, "0")}`,
        title: `Bulk item ${i}`,
        quantity: i + 1,
        unitCostKes: 100 + i,
        lineTotalKes: (i + 1) * (100 + i),
      })),
    };
    const cells = pdfCells(await poPdfBytes(long));
    for (const line of long.lines) {
      expect(after(cells, line.sku, 4)[3], line.sku).toBe(poAmount(line.lineTotalKes));
    }
  });

  it("renders the cost mask rather than throwing when costs are withheld", async () => {
    const blind: PoDocumentData = {
      ...doc,
      lines: doc.lines.map((l) => ({ ...l, unitCostKes: null, lineTotalKes: null })),
      subtotalKes: null,
    };
    const cells = pdfCells(await poPdfBytes(blind));
    expect(after(cells, `Total (${CURRENCY})`, 1)).toEqual(["•••"]);
  });

  it("names the file after the purchase order", () => {
    expect(poPdfFilename(doc)).toBe("PO-2087.pdf");
  });
});

describe("outbound seam attachments", () => {
  const original = { key: process.env.RESEND_API_KEY, from: process.env.EMAIL_FROM };

  beforeEach(() => {
    process.env.RESEND_API_KEY = "test-resend-key";
    process.env.EMAIL_FROM = "no-reply@wezesha.test";
  });

  afterEach(() => {
    process.env.RESEND_API_KEY = original.key;
    process.env.EMAIL_FROM = original.from;
  });

  function okFetch() {
    return vi.fn(async () => ({
      ok: true,
      status: 201,
      text: async () => "",
      json: async () => ({ id: "msg_1" }),
    })) as unknown as typeof fetch;
  }

  function bodyOf(fetchMock: typeof fetch) {
    const [, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    return JSON.parse(init.body);
  }

  it("posts exactly one attachment whose decoded bytes are a PDF", async () => {
    const fetchMock = okFetch();

    await sendEmail(
      {
        to: "orders@highland.example",
        subject: "Purchase order PO-2087",
        text: "body",
        attachments: [{ filename: poPdfFilename(doc), content: await poPdfBytes(doc) }],
      },
      fetchMock
    );

    const body = bodyOf(fetchMock);
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0].filename).toBe("PO-2087.pdf");
    const decoded = Buffer.from(body.attachments[0].content, "base64");
    expect(decoded.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("omits the attachments key for mail that carries no file", async () => {
    const fetchMock = okFetch();
    await sendEmail({ to: "user@example.test", subject: "Your code", text: "123456" }, fetchMock);
    expect(bodyOf(fetchMock)).not.toHaveProperty("attachments");
  });
});
