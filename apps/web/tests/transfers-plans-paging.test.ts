import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import {
  DEFAULT_SAVED_PLANS_QUERY,
  SAVED_PLANS_PAGE_SIZE,
  listDistributionPlansScreen,
  parseSavedPlansQuery,
  savedPlansSearch,
  type SavedPlansQuery,
} from "../lib/data/transfers";

/**
 * Saved transfer plans page and search on the server. The list used to stop at
 * twenty with nothing to say so, so the tests that matter here are the ones
 * about reachability: every plan lands on exactly one page, the counts describe
 * the list rather than the page, and the source branch the reader picked for the
 * proposal above survives a search or a page turn.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);
const SLUG = "transfers-plans-paging-probe";

describe("saved-plans query <-> URL", () => {
  const carry = [
    { name: "from", value: "loc_123" },
    { name: "cover", value: "21" },
  ];

  it("round-trips the search and the page", () => {
    const q: SavedPlansQuery = { search: "warehouse push", page: 2 };
    expect(parseSavedPlansQuery(qs(savedPlansSearch(carry, q)))).toEqual(q);
  });

  it("carries the source branch and cover target through both", () => {
    // Paging the plans must not throw away the proposal the reader is building
    // above them: both live in the same query string.
    const params = qs(savedPlansSearch(carry, { search: "push", page: 1 }));
    expect(params.from).toBe("loc_123");
    expect(params.cover).toBe("21");
  });

  it("leaves a clean /transfers URL alone", () => {
    expect(savedPlansSearch([], DEFAULT_SAVED_PLANS_QUERY)).toBe("");
    expect(parseSavedPlansQuery({})).toEqual(DEFAULT_SAVED_PLANS_QUERY);
  });

  it("tolerates a hand-edited page and caps the text", () => {
    expect(parseSavedPlansQuery({ page: "-4" }).page).toBe(0);
    expect(parseSavedPlansQuery({ page: "nonsense" }).page).toBe(0);
    expect(parseSavedPlansQuery({ q: "  push  " }).search).toBe("push");
    expect(parseSavedPlansQuery({ q: "x".repeat(500) }).search).toHaveLength(120);
  });

  /** `?a=1&b=2` as the shape Next hands a page. */
  function qs(search: string): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of new URLSearchParams(search)) out[k] = v;
    return out;
  }
});

describe.skipIf(!runnable)("paged saved plans (local db)", () => {
  const COUNT = SAVED_PLANS_PAGE_SIZE + 3;
  const UNIT_COST = 250;
  let tenantId: string;
  let warehouseId: string;
  let branchId: string;
  let productId: string;
  let valuedPlanId: string;

  beforeAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    const tenant = await prismaService.tenant.create({
      data: { name: "Plans Paging Probe", slug: SLUG, plan: "growth" },
    });
    tenantId = tenant.id;
    warehouseId = (
      await prismaService.location.create({
        data: { tenantId, name: "Ruaraka Warehouse", locationType: "warehouse" },
      })
    ).id;
    branchId = (
      await prismaService.location.create({
        data: { tenantId, name: "Kisumu Shop", locationType: "branch" },
      })
    ).id;
    productId = (
      await prismaService.product.create({
        data: { tenantId, sku: "PRB-001", title: "Probe Product", costKes: UNIT_COST },
      })
    ).id;

    // Distinct timestamps, newest last, so "newest first" is a fact the test can
    // assert rather than whatever order equal timestamps happen to come back in.
    for (let i = 1; i <= COUNT; i++) {
      const n = String(i).padStart(2, "0");
      const plan = await prismaService.distributionPlan.create({
        data: {
          tenantId,
          name: `Probe plan ${n}`,
          fromLocationId: warehouseId,
          createdAt: new Date(Date.UTC(2026, 0, i, 8, 0, 0)),
        },
      });
      if (i === 1) {
        valuedPlanId = plan.id;
        await prismaService.distributionPlanLine.create({
          data: {
            tenantId,
            planId: plan.id,
            productId,
            sku: "PRB-001",
            title: "Probe Product",
            toLocationId: branchId,
            qty: 4,
          },
        });
      }
    }
  }, 120_000);

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    await prismaService.$disconnect();
  });

  const query = (over: Partial<SavedPlansQuery> = {}): SavedPlansQuery => ({
    ...DEFAULT_SAVED_PLANS_QUERY,
    ...over,
  });

  it("counts every saved plan while sending one page of them", async () => {
    const screen = await listDistributionPlansScreen(tenantId, {
      canViewCosts: true,
      query: query(),
    });
    expect(screen.total).toBe(COUNT);
    expect(screen.matched).toBe(COUNT);
    expect(screen.plans).toHaveLength(SAVED_PLANS_PAGE_SIZE);
    expect(screen.page).toBe(0);
    expect(screen.pageCount).toBe(2);
    expect(screen.from).toBe(1);
    // Newest first, as the card promises.
    expect(screen.plans[0]!.name).toBe(`Probe plan ${String(COUNT).padStart(2, "0")}`);
  });

  it("gives every page a distinct slice, and no plan twice", async () => {
    const seen: string[] = [];
    const first = await listDistributionPlansScreen(tenantId, {
      canViewCosts: true,
      query: query(),
    });
    for (let page = 0; page < first.pageCount; page++) {
      const screen = await listDistributionPlansScreen(tenantId, {
        canViewCosts: true,
        query: query({ page }),
      });
      expect(screen.page).toBe(page);
      expect(screen.from).toBe(page * SAVED_PLANS_PAGE_SIZE + 1);
      expect(screen.matched).toBe(first.matched);
      seen.push(...screen.plans.map((p) => p.id));
    }
    expect(seen).toHaveLength(COUNT);
    expect(new Set(seen).size).toBe(COUNT);
  });

  it("narrows on the plan name and on the branch it moves from", async () => {
    const byName = await listDistributionPlansScreen(tenantId, {
      canViewCosts: true,
      query: query({ search: "plan 07" }),
    });
    expect(byName.matched).toBe(1);
    expect(byName.plans[0]!.name).toBe("Probe plan 07");
    // The count of saved plans is not what the search changed.
    expect(byName.total).toBe(COUNT);

    const byLocation = await listDistributionPlansScreen(tenantId, {
      canViewCosts: true,
      query: query({ search: "ruaraka" }),
    });
    expect(byLocation.matched).toBe(COUNT);

    const none = await listDistributionPlansScreen(tenantId, {
      canViewCosts: true,
      query: query({ search: "zzzz-no-such-plan" }),
    });
    expect(none.matched).toBe(0);
    expect(none.plans).toHaveLength(0);
    expect(none.page).toBe(0);
    expect(none.pageCount).toBe(1);
  });

  it("clamps a page past the end instead of showing an empty table", async () => {
    const screen = await listDistributionPlansScreen(tenantId, {
      canViewCosts: true,
      query: query({ page: 999 }),
    });
    expect(screen.page).toBe(screen.pageCount - 1);
    expect(screen.plans.length).toBeGreaterThan(0);
  });

  it("keeps a money-blind member's page identical except for the value", async () => {
    const owner = await listDistributionPlansScreen(tenantId, {
      canViewCosts: true,
      query: query({ page: 1 }),
    });
    const member = await listDistributionPlansScreen(tenantId, {
      canViewCosts: false,
      query: query({ page: 1 }),
    });

    // The plan carrying a line is the oldest, so it sits on the last page.
    const ownerValued = owner.plans.find((p) => p.id === valuedPlanId)!;
    expect(ownerValued.valueKes).toBeCloseTo(4 * UNIT_COST, 5);
    expect(member.plans.every((p) => p.valueKes === null)).toBe(true);
    // Same plans, same order, same units — only the money is gone.
    expect(member.plans.map((p) => `${p.id}:${p.units}:${p.lineCount}`)).toEqual(
      owner.plans.map((p) => `${p.id}:${p.units}:${p.lineCount}`),
    );
    expect(member.matched).toBe(owner.matched);
    expect(member.total).toBe(owner.total);
  });

  it("never reaches another tenant's plans", async () => {
    const other = await prismaService.tenant.create({
      data: { name: "Other Shop", slug: `${SLUG}-other` },
    });
    try {
      const screen = await listDistributionPlansScreen(other.id, {
        canViewCosts: true,
        query: query(),
      });
      expect(screen.total).toBe(0);
      expect(screen.plans).toEqual([]);
    } finally {
      await prismaService.tenant.delete({ where: { id: other.id } });
    }
  });
});
