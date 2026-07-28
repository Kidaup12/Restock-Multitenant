import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The owner's own controls on a product, against the local database: archive /
 * restore / keep-active, and the typed selling price. The rules that matter are
 * that archiving takes a SKU off the buy list the moment it is written (without
 * losing its stock or history), that restoring hands it back, that a rejected
 * price leaves the stored one untouched, and that neither control is reachable
 * without the permission the equivalent cost control needs. Session and
 * revalidation are stubbed; the database work is real. Skips with no local db.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const authState = vi.hoisted(() => ({
  session: null as { user: { id: string; name: string | null; email: string } } | null,
  // Mirrors what resolveActiveMembership actually returns: it includes the
  // tenant relation, and server actions read tenant.currency off it. A double
  // that omits it compiles and then fails at run time.
  membership: null as
    | {
        tenantId: string;
        displayName: string | null;
        role: string;
        permissions: unknown;
        tenant: { currency: string };
      }
    | null,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({
  requireSession: async () => authState.session,
  activeMembership: async () => authState.membership,
}));

import { BUYABLE_PRODUCT_WHERE, prismaForTenant, prismaService } from "@wezesha/db";
import { getStockCatalogue } from "@/lib/data/stock";
import { getOwnerFlags } from "../app/(shell)/stock/owner-flags";
import { setPriceAction, setProductActiveAction } from "../app/(shell)/stock/actions";

const SLUGS = ["owner-edit-a", "owner-edit-b"];

describe.skipIf(!runnable)("owner product controls (local db)", () => {
  let tenantA: string;
  let tenantB: string;
  const A: Record<string, string> = {};
  let foreignProduct: string;

  async function product(tenantId: string, sku: string, over: Record<string, unknown> = {}) {
    const p = await prismaService.product.create({
      data: { tenantId, sku, title: `Product ${sku}`, priceKes: 1000, costKes: 400, costSource: "manual", currentStock: 6, ...over },
    });
    return p.id;
  }

  /** Whether the buy list would still consider this row — the real predicate the
   *  plan is built from, not a re-derivation of it. */
  const onBuyList = async (tenantId: string, productId: string) =>
    (await prismaForTenant(tenantId).product.count({ where: { id: productId, ...BUYABLE_PRODUCT_WHERE } })) === 1;

  beforeAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: { in: SLUGS } } });
    tenantA = (await prismaService.tenant.create({ data: { name: "Owner Edit A", slug: SLUGS[0]! } })).id;
    tenantB = (await prismaService.tenant.create({ data: { name: "Owner Edit B", slug: SLUGS[1]! } })).id;

    A.retire = await product(tenantA, "OWN-RETIRE", { currentStock: 12 });
    A.pin = await product(tenantA, "OWN-PIN");
    A.price = await product(tenantA, "OWN-PRICE", { priceKes: 500 });
    foreignProduct = await product(tenantB, "OWN-FOREIGN");
  });

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    await prismaService.$disconnect();
  });

  function actAs(tenantId: string, permissions: unknown) {
    authState.session = { user: { id: "actor-1", name: "Owner", email: "owner@example.test" } };
    authState.membership = { tenantId, displayName: "Owner", role: "OWNER", permissions, tenant: { currency: "KES" } };
  }

  // ── Archive / restore ──────────────────────────────────────────────────────

  it("archiving drops the SKU off the buy list and out of the selling view, stock intact", async () => {
    actAs(tenantA, null);
    expect(await onBuyList(tenantA, A.retire!)).toBe(true);

    const res = await setProductActiveAction({ productId: A.retire!, mode: "archive" });
    expect(res.ok).toBe(true);

    const p = await prismaForTenant(tenantA).product.findUnique({ where: { id: A.retire! } });
    expect(p!.active).toBe(false);
    expect(p!.activeOverride).toBe(false);
    expect(await onBuyList(tenantA, A.retire!)).toBe(false);

    // It leaves the default view but keeps everything the owner has money in.
    const row = (await getStockCatalogue(tenantA, { canViewCosts: true })).find((r) => r.productId === A.retire!)!;
    expect(row.buyable).toBe(false);
    expect(row.lifecycle).toBe("deactivated");
    expect(row.onHandUnits).toBe(12);
    expect(row.lifecycleReason).toBe("Deactivated");
  });

  it("archiving is audited", async () => {
    const audit = await prismaForTenant(tenantA).auditEvent.findFirst({
      where: { entity: "Product", entityId: A.retire!, action: "edited" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit!.meta as Record<string, unknown>).toMatchObject({ field: "active", mode: "archive", to: false });
  });

  it("restoring returns it to the buy list and the selling view", async () => {
    actAs(tenantA, null);
    expect((await setProductActiveAction({ productId: A.retire!, mode: "restore" })).ok).toBe(true);

    expect(await onBuyList(tenantA, A.retire!)).toBe(true);
    const row = (await getStockCatalogue(tenantA, { canViewCosts: true })).find((r) => r.productId === A.retire!)!;
    expect(row.buyable).toBe(true);
    expect(row.lifecycle).toBe("unlisted"); // never published; still selling
  });

  it("keep-active pins both flags, and the row editor can read them back", async () => {
    actAs(tenantA, null);
    expect((await setProductActiveAction({ productId: A.pin!, mode: "keep_active" })).ok).toBe(true);

    const p = await prismaForTenant(tenantA).product.findUnique({ where: { id: A.pin! } });
    expect(p!.active).toBe(true);
    expect(p!.activeOverride).toBe(true);

    const flags = await getOwnerFlags(tenantA);
    expect(flags[A.pin!]).toEqual({ active: true, activeOverride: true });
  });

  it("archiving a pinned SKU clears the pin — two contradictory owner decisions never coexist", async () => {
    actAs(tenantA, null);
    await setProductActiveAction({ productId: A.pin!, mode: "archive" });
    const p = await prismaForTenant(tenantA).product.findUnique({ where: { id: A.pin! } });
    expect(p!).toMatchObject({ active: false, activeOverride: false });
    await setProductActiveAction({ productId: A.pin!, mode: "keep_active" }); // restore the fixture
  });

  it("rejects archive/restore without manage_settings", async () => {
    actAs(tenantA, []); // no permissions
    expect(await setProductActiveAction({ productId: A.retire!, mode: "archive" })).toEqual({
      ok: false,
      error: "You don't have settings access in this workspace.",
    });
    expect((await prismaForTenant(tenantA).product.findUnique({ where: { id: A.retire! } }))!.active).toBe(true);
  });

  it("cannot archive another tenant's product (RLS)", async () => {
    actAs(tenantA, null);
    expect(await setProductActiveAction({ productId: foreignProduct, mode: "archive" })).toEqual({
      ok: false,
      error: "That product no longer exists.",
    });
    expect((await prismaForTenant(tenantB).product.findUnique({ where: { id: foreignProduct } }))!.active).toBe(true);
  });

  // ── Selling price ──────────────────────────────────────────────────────────

  it("persists a decimal price", async () => {
    actAs(tenantA, null);
    const res = await setPriceAction({ productId: A.price!, priceKes: 799.5 });
    expect(res.ok).toBe(true);
    expect((await prismaForTenant(tenantA).product.findUnique({ where: { id: A.price! } }))!.priceKes).toBe(799.5);
  });

  it("audits the price change", async () => {
    const audit = await prismaForTenant(tenantA).auditEvent.findFirst({
      where: { entity: "Product", entityId: A.price!, action: "price_changed" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit!.meta as Record<string, unknown>).toMatchObject({ field: "priceKes", from: 500, to: 799.5 });
  });

  it("rejects a negative or non-finite price and leaves the stored one standing", async () => {
    actAs(tenantA, null);
    for (const bad of [-50, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await setPriceAction({ productId: A.price!, priceKes: bad })).toEqual({
        ok: false,
        error: "Enter a price of zero or more.",
      });
    }
    // Nothing persisted: the value from the last good write survives a re-read.
    expect((await prismaForTenant(tenantA).product.findUnique({ where: { id: A.price! } }))!.priceKes).toBe(799.5);
  });

  it("refuses a money-blind member — price feeds margin", async () => {
    actAs(tenantA, ["manage_settings"]); // settings, but no view_costs
    expect(await setPriceAction({ productId: A.price!, priceKes: 1 })).toEqual({
      ok: false,
      error: "You don't have price-editing access in this workspace.",
    });
    expect((await prismaForTenant(tenantA).product.findUnique({ where: { id: A.price! } }))!.priceKes).toBe(799.5);
  });

  it("cannot price another tenant's product (RLS)", async () => {
    actAs(tenantA, null);
    expect(await setPriceAction({ productId: foreignProduct, priceKes: 5 })).toEqual({
      ok: false,
      error: "That product no longer exists.",
    });
    expect((await prismaForTenant(tenantB).product.findUnique({ where: { id: foreignProduct } }))!.priceKes).toBe(1000);
  });
});
