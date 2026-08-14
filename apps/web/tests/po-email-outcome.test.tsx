import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * "Did that email actually arrive?" answered on the order itself.
 *
 * The purchase order page must say what happened to the supplier's email —
 * that it went out, or that it did not — and must say something different for
 * each. A page that hardcoded a cheerful "sent" would pass a happy-path test,
 * so both outcomes are rendered from the same code and compared.
 *
 * The log rows are correlated to the order by the PO number carried in the
 * email subject, which is unique per workspace; the last assertion pins that
 * subject format so a change to it fails here rather than silently emptying
 * the screen.
 *
 * Skips without the local database.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const authState = vi.hoisted(() => ({
  session: null as { user: { id: string; name: string | null; email: string } } | null,
  membership: null as
    | { tenantId: string; displayName: string | null; role: string; permissions: unknown }
    | null,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({
  requireSession: async () => authState.session,
  activeMembership: async () => authState.membership,
}));
// next/link wants an app-router context a bare static render doesn't provide.
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

import { prismaService } from "@wezesha/db";
import { poEmailSubject } from "../lib/po/po-email";
import { poEmailLogSubjectMatch } from "../lib/data/orders";
import PoDetailPage from "../app/(shell)/orders/[id]/page";

const SLUG = "po-email-outcome";
const SUPPLIER_EMAIL = "orders@po-email-outcome.example";
const SHOP = "Outcome Shop";

async function render(poId: string): Promise<string> {
  const element = await PoDetailPage({ params: Promise.resolve({ id: poId }) });
  return renderToStaticMarkup(element);
}

describe.skipIf(!runnable)("purchase order email outcome (local db)", () => {
  let tenantId: string;
  const po: Record<string, string> = {};

  beforeAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    const tenant = await prismaService.tenant.create({ data: { name: SHOP, slug: SLUG } });
    tenantId = tenant.id;
    const supplier = await prismaService.supplier.create({
      data: { tenantId, name: "Outcome Supplier", email: SUPPLIER_EMAIL, moq: 1, leadTimeAvgDays: 7 },
    });
    const sentAt = new Date("2026-08-12T09:00:00Z");

    // Three orders, one per outcome: the email went out, the email failed, and
    // no attempt was ever logged.
    for (const [key, poNumber] of [
      ["sent", "PO-9001"],
      ["failed", "PO-9002"],
      ["none", "PO-9003"],
      ["rolledback", "PO-9004"],
    ] as const) {
      const product = await prismaService.product.create({
        data: {
          tenantId,
          supplierId: supplier.id,
          sku: `SKU-${key}`,
          title: `Item ${key}`,
          costKes: 700,
          priceKes: 1100,
          currentStock: 3,
        },
      });
      const created = await prismaService.purchaseOrder.create({
        data: {
          tenantId,
          supplierId: supplier.id,
          poNumber,
          // A failed send hands the order back to draft with no sentAt — the
          // state the shop is left in when the supplier never got the email.
          status: key === "rolledback" ? "draft" : "sent",
          sentAt: key === "rolledback" ? null : sentAt,
          subtotalKes: 4200,
          lines: {
            create: [
              {
                tenantId,
                productId: product.id,
                sku: `SKU-${key}`,
                title: `Item ${key}`,
                quantity: 6,
                unitCostKes: 700,
                lineTotalKes: 4200,
              },
            ],
          },
        },
      });
      po[key] = created.id;
    }

    await prismaService.emailLog.createMany({
      data: [
        {
          tenantId,
          to: SUPPLIER_EMAIL,
          subject: `Purchase order PO-9001 from ${SHOP}`,
          kind: "purchase_order",
          status: "sent",
          providerId: "provider-1",
          createdAt: sentAt,
        },
        {
          tenantId,
          to: SUPPLIER_EMAIL,
          subject: `Purchase order PO-9002 from ${SHOP}`,
          kind: "purchase_order",
          status: "failed",
          error: "Resend send failed (422): domain not verified",
          createdAt: sentAt,
        },
        {
          tenantId,
          to: SUPPLIER_EMAIL,
          subject: `Purchase order PO-9004 from ${SHOP}`,
          kind: "purchase_order",
          status: "failed",
          error: "Resend send failed (422): domain not verified",
          createdAt: sentAt,
        },
      ],
    });

    authState.session = { user: { id: "actor-1", name: "Owner", email: "owner@example.test" } };
    authState.membership = { tenantId, displayName: "Owner", role: "OWNER", permissions: null };
  }, 30_000);

  afterAll(async () => {
    await prismaService.emailLog.deleteMany({ where: { tenantId } });
    await prismaService.tenant.deleteMany({ where: { id: tenantId } });
    await prismaService.$disconnect();
  });

  it("says the email did not reach the supplier when the log says it failed", async () => {
    const html = await render(po.failed!);
    expect(html).toContain(SUPPLIER_EMAIL);
    expect(html).toMatch(/did not go out|never reached/i);
  });

  it("says the email went out when the log says it was sent", async () => {
    const html = await render(po.sent!);
    expect(html).toContain(SUPPLIER_EMAIL);
    expect(html).toMatch(/went out/i);
  });

  it("renders a different outcome for a sent email than for a failed one", async () => {
    const [sent, failed] = await Promise.all([render(po.sent!), render(po.failed!)]);
    // The words each outcome uses must not appear under the other one — the
    // check a page hardcoding one message would fail.
    expect(sent).toMatch(/went out/i);
    expect(sent).not.toMatch(/did not go out|never reached/i);
    expect(failed).not.toMatch(/went out/i);
  });

  it("does not claim an email for an order with no log row", async () => {
    const html = await render(po.none!);
    expect(html).not.toMatch(/went out/i);
    expect(html).toMatch(/no email record/i);
  });

  it("keeps the log's own wording off the screen", async () => {
    const html = await render(po.failed!);
    // The provider's error text and the subject line are engineer-facing; the
    // shop owner gets plain language and no raw log content.
    expect(html).not.toContain("Resend");
    expect(html).not.toContain("Purchase order PO-9002 from");
  });

  it("shows the failure on an order the failed send handed back to draft", async () => {
    // The state a real failure leaves behind: status draft, no sentAt, and a
    // failed row in the ledger. If the note hung off sentAt it would say
    // nothing here — the one screen where the shop needs to be told.
    const html = await render(po.rolledback!);
    expect(html).toMatch(/did not go out/i);
    expect(html).toContain(SUPPLIER_EMAIL);
  });

  it("correlates on a subject the send path actually produces", async () => {
    const subject = poEmailSubject({
      poNumber: "PO-9001",
      shop: { name: SHOP },
    } as Parameters<typeof poEmailSubject>[0]);
    expect(subject).toContain(poEmailLogSubjectMatch("PO-9001"));
    // A neighbouring number must not match the same order.
    expect(subject).not.toContain(poEmailLogSubjectMatch("PO-900"));
  });
});
