import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CurrencyProvider } from "../components/currency-provider";
import type { SupplierRow } from "../lib/data/suppliers";
import type { DeclaredClosure, DeclaredPromo } from "../lib/data/signals";
import type { BuyList, BuyListRow } from "../lib/data/plan";
import type { ProductDetail } from "../lib/data/product-detail";

/**
 * Two things a shop reads off a table, both of which used to move under it.
 *
 * 1. The action column appeared for someone who could use it and vanished for
 *    everyone else, so the same screen had a different shape depending on who
 *    opened it. The column now always renders; what sits inside the cell is
 *    still the permission's business, and every test below checks both halves —
 *    the header is there AND the control is not.
 * 2. "On order" read as a purchase order the shop had raised. The number is the
 *    en-route figure: stock at an en-route location plus the store's own
 *    incoming count, MAXed against outstanding purchase-order units. It is
 *    stock on its way, however it was set in motion.
 */

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

const { SuppliersView } = await import("../app/(shell)/suppliers/suppliers-view");
const { TeamView } = await import("../app/(shell)/settings/team/team-view");
const { SignalsView } = await import("../app/(shell)/settings/signals/signals-view");
const { BuyChecklist } = await import("../app/(shell)/plan/buy-checklist");
const { ProductDetailView } = await import(
  "../app/(shell)/products/[productId]/product-detail-view"
);

const headerCells = (html: string) => (html.match(/<th\b/g) ?? []).length;
const bodyCells = (html: string) => (html.match(/<td\b/g) ?? []).length;

/* ── suppliers ─────────────────────────────────────────────────────────── */

const supplierRow = (over: Partial<SupplierRow> = {}): SupplierRow => ({
  id: "sup-1",
  name: "Nairobi Supplies",
  group: null,
  country: null,
  currency: "KES",
  email: null,
  moq: 1,
  leadTimeTypedDays: 14,
  leadTimeStdDays: 0,
  learnedLeadDays: null,
  deliveriesTracked: 0,
  onTimePct: null,
  onTimeStatus: "no_deliveries",
  fillRatePct: null,
  shortShipPct: null,
  assignedProductCount: 3,
  speedBand: "local",
  drift: { drifting: false, deltaDays: null, direction: null },
  ...over,
});

const renderSuppliers = (canManage: boolean) =>
  renderToStaticMarkup(
    <SuppliersView
      rows={[supplierRow()]}
      unassignedBrands={[]}
      supplierOptions={[]}
      assignableProducts={[]}
      defaultCurrency="KES"
      canManage={canManage}
    />
  );

describe("the suppliers action column", () => {
  it("is there for someone who cannot use it", () => {
    expect(renderSuppliers(false)).toContain("Actions");
  });

  it("has the same shape either way", () => {
    expect(headerCells(renderSuppliers(false))).toBe(headerCells(renderSuppliers(true)));
    expect(bodyCells(renderSuppliers(false))).toBe(bodyCells(renderSuppliers(true)));
  });

  // The discriminating control: the column is a column, not a permission. A
  // member sees the heading and an empty cell — never a button they can't use.
  it("still keeps the buttons behind the permission", () => {
    const member = renderSuppliers(false);
    expect(member).not.toContain(">Edit<");
    expect(member).not.toContain(">Remove<");
    // And the manager really does get them, so the check above can fail.
    const manager = renderSuppliers(true);
    expect(manager).toContain(">Edit<");
    expect(manager).toContain(">Remove<");
  });
});

/* ── team ──────────────────────────────────────────────────────────────── */

const renderTeam = (canManage: boolean) =>
  renderToStaticMarkup(
    <TeamView
      seats={{ allowed: true, used: 1, max: 5, message: null }}
      rows={[
        {
          id: "mem-1",
          name: "Counter staff",
          email: "counter@example.com",
          role: "MEMBER",
          joined: "12 Aug 2026",
          isSelf: false,
          roleOptions: canManage ? ["OWNER"] : [],
          // Removable either way, so `canManage` is the only thing deciding
          // whether the button renders.
          canRemove: true,
        },
      ]}
      invites={[]}
      canManage={canManage}
      inviteRoles={canManage ? ["MEMBER"] : []}
    />
  );

describe("the members action column", () => {
  it("has the same shape either way", () => {
    expect(headerCells(renderTeam(false))).toBe(headerCells(renderTeam(true)));
    expect(bodyCells(renderTeam(false))).toBe(bodyCells(renderTeam(true)));
  });

  it("still keeps the remove button behind the permission", () => {
    expect(renderTeam(false)).not.toContain("Remove Counter staff");
    expect(renderTeam(true)).toContain("Remove Counter staff");
  });
});

/* ── declared signals ──────────────────────────────────────────────────── */

const promo: DeclaredPromo = {
  id: "promo-1",
  startKey: "2026-08-01",
  endKey: "2026-08-03",
  rangeLabel: "1–3 Aug 2026",
  scope: "all",
  scopeValue: null,
  scopeLabel: "Everything in the shop",
  promoType: "discount",
  discountPct: 20,
  notes: null,
  status: "past",
  daysExcluded: 3,
};

const closure: DeclaredClosure = {
  locationId: "loc-1",
  locationName: "Main shop",
  dayKey: "2026-08-05",
  dayLabel: "5 Aug 2026",
  reason: "holiday",
  note: null,
  countsAsClosed: true,
};

const renderSignals = (canManage: boolean) =>
  renderToStaticMarkup(
    <SignalsView
      promos={[promo]}
      closures={[closure]}
      locations={[{ id: "loc-1", name: "Main shop", sells: true }]}
      catalogue={{ brands: [], categories: [], products: [] }}
      canManage={canManage}
    />
  );

describe("the declared-signals action columns", () => {
  it("keep the same shape either way, on both tables", () => {
    expect(headerCells(renderSignals(false))).toBe(headerCells(renderSignals(true)));
    expect(bodyCells(renderSignals(false))).toBe(bodyCells(renderSignals(true)));
  });

  it("still keep both remove buttons behind the permission", () => {
    const member = renderSignals(false);
    expect(member).not.toContain("Remove the promotion on");
    expect(member).not.toContain("Remove the closed day on");
    const manager = renderSignals(true);
    expect(manager).toContain("Remove the promotion on");
    expect(manager).toContain("Remove the closed day on");
  });
});

/* ── the inbound label ─────────────────────────────────────────────────── */

const buyRow: BuyListRow = {
  predictionId: "pred-1",
  productId: "prod-1",
  sku: "BUY-1",
  title: "Curl Cream 200ml",
  vendor: null,
  supplierName: "Nairobi Supplies",
  onHandUnits: 12,
  onOrderUnits: 6,
  daysUntilStockout: 18,
  daysLeftToOrder: 4,
  leadDays: 14,
  orderByDate: new Date("2026-08-31T00:00:00Z"),
  urgency: "high",
  tier: "order_today",
  recommendedQty: 24,
  overriddenQty: null,
  runRatePerDay: 0.6,
  moq: 1,
  leadFloored: false,
  orderQty: 24,
  abc: "A",
  category: null,
  unitCostKes: 100,
  lineTotalKes: 2400,
  priceKes: 200,
  reasoning: "cover runs out inside the lead time",
  explain: null,
  qtySummary: "12 in stock + 6 incoming + 24 ordered = 42",
  confidence: "sure",
  coldStart: null,
  borrowedFromTitle: null,
  plannable: "ok",
  atRiskKes: 0,
  revenue30dKes: 5400,
};

const buyList: BuyList = {
  forecastRunId: "run-1",
  runDate: new Date("2026-08-14T00:00:00Z"),
  rows: [buyRow],
  excluded: [],
  totalPredicted: 1,
  totalCostKes: 2400,
};

const productDetail: ProductDetail = {
  productId: "prod-1",
  sku: "BUY-1",
  title: "Curl Cream 200ml",
  variantTitle: null,
  vendor: null,
  productType: null,
  imageUrl: null,
  abc: "A",
  lifecycle: "active",
  lifecycleLabel: "Active",
  heldReason: null,
  shopifyStatus: "active",
  onHandUnits: 12,
  onOrderUnits: 6,
  expectedArrivalLabel: "due 20 Aug",
  runRatePerDay: 0.6,
  daysCover: 18,
  priceKes: 200,
  unitCostKes: 100,
  costSource: "typed",
  stockValueKes: 1200,
  supplierName: "Nairobi Supplies",
  supplierLeadDays: 14,
  supplierMoq: null,
  effectiveLeadDays: 14,
  months: [],
  revenue30dKes: 5400,
  prediction: null,
};

describe("the inbound figure is named for what it counts", () => {
  it("says so on the buy list", () => {
    const html = renderToStaticMarkup(
      <CurrencyProvider currency="KES">
        <BuyChecklist
          buyList={buyList}
          canViewCosts
          canOverride={false}
          urgentOnly={false}
          onUrgentOnlyChange={() => {}}
          whatIfActive={false}
          onWhatIfChange={() => {}}
        />
      </CurrencyProvider>
    );
    expect(html).toContain("En route");
    expect(html).not.toContain("On order");
  });

  it("says so on the product page", () => {
    const html = renderToStaticMarkup(
      <ProductDetailView detail={productDetail} canViewCosts />
    );
    expect(html).toContain("En route");
    expect(html).not.toContain("On order");
  });
});
