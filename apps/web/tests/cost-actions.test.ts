import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Catalogue + cost server actions against the local database: the manual cost
 * pin (and release), the not-for-sale toggle and its effect on the sellable
 * read, category rename/delete, the permission gates (cost edits need view_costs;
 * catalogue edits need manage_settings), and RLS scoping. Session + revalidation
 * are stubbed; the database work is real. Skips with no local db.
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

import { prismaForTenant, prismaService } from "@wezesha/db";
import { computeMoneyBand, type MoneyRow } from "@/lib/cost";
import { getStockCatalogue, getCustomCategories } from "@/lib/data/stock";
import {
  assignCategoryAction,
  clearCostPinAction,
  deleteCategoryAction,
  renameCategoryAction,
  setManualCostAction,
  setNotForSaleAction,
} from "../app/(shell)/products/actions";
import { applyCostImportAction } from "../app/(shell)/costs/actions";

const SLUGS = ["cost-action-a", "cost-action-b"];

describe.skipIf(!runnable)("cost + catalogue actions (local db)", () => {
  let tenantA: string;
  let tenantB: string;
  const A: Record<string, string> = {};
  let foreignProduct: string;

  async function product(tenantId: string, key: string, over: Record<string, unknown>) {
    const p = await prismaService.product.create({
      data: { tenantId, sku: key, title: `Product ${key}`, priceKes: 1000, ...over },
    });
    return p.id;
  }

  beforeAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: { in: SLUGS } } });
    tenantA = (await prismaService.tenant.create({ data: { name: "Cost A", slug: SLUGS[0]! } })).id;
    tenantB = (await prismaService.tenant.create({ data: { name: "Cost B", slug: SLUGS[1]! } })).id;

    A.cost = await product(tenantA, "COST-1", { costKes: 500, costSource: "shopify", currentStock: 10 });
    A.synced = await product(tenantA, "SYNC-1", { costKes: 400, costSource: "shopify", currentStock: 10, lastSyncedCostKes: 400 });
    A.suspect = await product(tenantA, "SUS-1", { costKes: 1200, costSource: "shopify", priceKes: 1000, currentStock: 5 });
    A.nfs = await product(tenantA, "NFS-1", { costKes: 300, costSource: "shopify", currentStock: 8 });
    A.cat1 = await product(tenantA, "CAT-1", { customCategory: "Old", currentStock: 1 });
    A.cat2 = await product(tenantA, "CAT-2", { customCategory: "Old", currentStock: 1 });
    foreignProduct = await product(tenantB, "B-1", { costKes: 100, costSource: "shopify" });
  });

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    await prismaService.$disconnect();
  });

  function actAs(tenantId: string, permissions: unknown) {
    authState.session = { user: { id: "actor-1", name: "Owner", email: "owner@example.test" } };
    authState.membership = { tenantId, displayName: "Owner", role: "OWNER", permissions, tenant: { currency: "KES" } };
  }

  // ── Manual cost pin ──────────────────────────────────────────────────────

  it("pins a manual cost + costSource=manual, and audits cost_changed", async () => {
    actAs(tenantA, null);
    const res = await setManualCostAction({ productId: A.cost, costKes: 650 });
    expect(res.ok).toBe(true);

    const p = await prismaForTenant(tenantA).product.findUnique({ where: { id: A.cost } });
    expect(p!.costKes).toBe(650);
    expect(p!.costSource).toBe("manual");

    const audit = await prismaForTenant(tenantA).auditEvent.findFirst({
      where: { entity: "Product", entityId: A.cost, action: "cost_changed" },
      orderBy: { createdAt: "desc" },
    });
    expect((audit!.meta as { to: number; source: string })).toMatchObject({ to: 650, source: "manual" });
  });

  it("rejects a zero cost (zero-as-missing)", async () => {
    actAs(tenantA, null);
    expect(await setManualCostAction({ productId: A.cost, costKes: 0 })).toEqual({
      ok: false,
      error: "Enter a cost greater than zero.",
    });
  });

  it("rejects a money-blind member (no view_costs) from editing cost", async () => {
    actAs(tenantA, ["manage_settings"]); // has settings, not view_costs
    const res = await setManualCostAction({ productId: A.cost, costKes: 700 });
    expect(res).toEqual({ ok: false, error: "You don't have cost-editing access in this workspace." });
  });

  it("cannot pin a cost on another tenant's product (RLS)", async () => {
    actAs(tenantA, null);
    expect(await setManualCostAction({ productId: foreignProduct, costKes: 1 })).toEqual({
      ok: false,
      error: "That product no longer exists.",
    });
  });

  it("releases the pin back to the retained synced cost", async () => {
    actAs(tenantA, null);
    await setManualCostAction({ productId: A.synced, costKes: 999 }); // pins over the synced 400
    const res = await clearCostPinAction({ productId: A.synced });
    expect(res.ok).toBe(true);
    const p = await prismaForTenant(tenantA).product.findUnique({ where: { id: A.synced } });
    expect(p!.costKes).toBe(400); // restored from lastSyncedCostKes
    expect(p!.costSource).toBe("shopify");
  });

  it("clears to missing when there's no synced cost to fall back to", async () => {
    actAs(tenantA, null);
    await setManualCostAction({ productId: A.cost, costKes: 650 });
    const res = await clearCostPinAction({ productId: A.cost });
    expect(res.ok).toBe(true);
    const p = await prismaForTenant(tenantA).product.findUnique({ where: { id: A.cost } });
    expect(p!.costSource).toBeNull();
    expect(p!.costKes).toBe(0);
  });

  // ── Not for sale ───────────────────────────────────────────────────────────

  it("not-for-sale leaves the row in the catalogue but out of cover + money band", async () => {
    actAs(tenantA, null);
    expect((await setNotForSaleAction({ productId: A.nfs, notForSale: true })).ok).toBe(true);

    const rows = await getStockCatalogue(tenantA, { canViewCosts: true });
    const nfs = rows.find((r) => r.productId === A.nfs)!;
    expect(nfs.notForSale).toBe(true);
    expect(nfs.verdict).toBeNull(); // no sellable verdict
    expect(nfs.daysCover).toBeNull();

    const band = computeMoneyBand(
      rows.map((r): MoneyRow => ({
        costKes: r.costKes ?? 0,
        priceKes: r.priceKes,
        sellableOnHand: r.onHandUnits,
        coverDays: r.daysCover,
        leadDays: r.leadDays,
        revenue30dKes: r.revenue30dKes,
        moneyAtRestKes: r.moneyAtRestKes ?? 0,
        notForSale: r.notForSale,
      })),
    );
    // Cash tied up excludes the not-for-sale row's capital.
    const sellableAtRest = rows.filter((r) => !r.notForSale).reduce((s, r) => s + (r.moneyAtRestKes ?? 0), 0);
    expect(band.cashTiedUpKes).toBe(sellableAtRest);
  });

  it("a suspect-cost product is held off the buy list", async () => {
    const rows = await getStockCatalogue(tenantA, { canViewCosts: true });
    const sus = rows.find((r) => r.productId === A.suspect)!;
    expect(sus.suspectCost).toBe(true);
    expect(sus.heldOffBuyList).toBe(true);
  });

  // ── Categories ───────────────────────────────────────────────────────────

  it("renames a category across its products", async () => {
    actAs(tenantA, null);
    const res = await renameCategoryAction({ from: "Old", to: "Fast movers" });
    expect(res.ok).toBe(true);
    const cats = await getCustomCategories(tenantA);
    expect(cats.find((c) => c.name === "Fast movers")?.count).toBe(2);
    expect(cats.find((c) => c.name === "Old")).toBeUndefined();
  });

  it("assigns a brand-new category inline (create-by-assign)", async () => {
    actAs(tenantA, null);
    expect((await assignCategoryAction({ productId: A.cat1, category: "Imports" })).ok).toBe(true);
    const cats = await getCustomCategories(tenantA);
    expect(cats.find((c) => c.name === "Imports")?.count).toBe(1);
  });

  it("deletes a category by clearing the field from its products", async () => {
    actAs(tenantA, null);
    const res = await deleteCategoryAction({ name: "Fast movers" });
    expect(res.ok).toBe(true);
    const cats = await getCustomCategories(tenantA);
    expect(cats.find((c) => c.name === "Fast movers")).toBeUndefined();
    // CAT-2 was in "Fast movers"; now uncategorised.
    const p = await prismaForTenant(tenantA).product.findUnique({ where: { id: A.cat2 } });
    expect(p!.customCategory).toBeNull();
  });

  it("rejects category edits without manage_settings", async () => {
    actAs(tenantA, []); // no permissions
    expect(await assignCategoryAction({ productId: A.cat1, category: "X" })).toEqual({
      ok: false,
      error: "You don't have settings access in this workspace.",
    });
  });

  // ── Cost import apply (write path) ─────────────────────────────────────────

  it("applies imported costs as manual pins, never overwriting a pin unless confirmed, idempotently", async () => {
    // IMP-A is synced (overwritable); IMP-B is a manual pin (protected).
    const impA = await product(tenantA, "IMP-A", { costKes: 100, costSource: "shopify", currentStock: 1 });
    const impB = await product(tenantA, "IMP-B", { costKes: 900, costSource: "manual", currentStock: 1 });
    actAs(tenantA, null);

    const csv = "sku,cost\nIMP-A,150\nIMP-B,999\nUNKNOWN-Z,10";

    const first = await applyCostImportAction({ csv });
    if (!first.ok) throw new Error(first.error);
    expect(first.data).toMatchObject({ applied: 1, matched: 2, unknown: 1, pinnedSkipped: 1 });

    const a1 = await prismaForTenant(tenantA).product.findUnique({ where: { id: impA } });
    expect(a1!.costKes).toBe(150);
    expect(a1!.costSource).toBe("manual");
    // The existing pin is untouched.
    const b1 = await prismaForTenant(tenantA).product.findUnique({ where: { id: impB } });
    expect(b1!.costKes).toBe(900);

    // Idempotent: re-applying writes the same value.
    const second = await applyCostImportAction({ csv });
    expect(second.ok).toBe(true);
    const a2 = await prismaForTenant(tenantA).product.findUnique({ where: { id: impA } });
    expect(a2!.costKes).toBe(150);

    // With overwrite confirmed, the pin is replaced.
    const forced = await applyCostImportAction({ csv, overwritePinned: true });
    expect(forced.ok).toBe(true);
    const b2 = await prismaForTenant(tenantA).product.findUnique({ where: { id: impB } });
    expect(b2!.costKes).toBe(999);
  });
});
