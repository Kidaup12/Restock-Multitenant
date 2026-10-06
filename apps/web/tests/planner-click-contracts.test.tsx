import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { BuyList } from "../lib/data/plan";

const state = vi.hoisted(() => ({ search: new URLSearchParams(), push: vi.fn(), refresh: vi.fn(), setters: [] as ReturnType<typeof vi.fn>[] }));
// Inspect actual event handlers with deterministic hook values; browser hydration
// and rendering are covered separately. No server actions execute in this suite.
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const setter = vi.fn();
    state.setters.push(setter);
    return [typeof initial === "function" ? initial() : initial, setter];
  },
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useEffect: () => {},
  useTransition: () => [false, (fn: () => void) => fn()],
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.push, refresh: state.refresh }), usePathname: () => "/plan", useSearchParams: () => state.search }));
vi.mock("../components/ui/confirm-dialog", () => ({ useConfirm: () => ({ confirm: vi.fn(), dialog: null }) }));
vi.mock("../app/(shell)/plan/scope-actions", () => ({ listScopes: vi.fn(), saveScope: vi.fn(), deleteScope: vi.fn() }));
vi.mock("../app/(shell)/plan/budget-planner", () => ({ BudgetPlanner: () => null }));
vi.mock("../app/(shell)/plan/buy-checklist", () => ({ BuyChecklist: () => null, QtyCell: () => null, MoqNote: () => null, TrustChips: () => null, WhyPanel: () => null, sortRows: (rows: unknown[]) => rows, dayLabel: () => "Today" }));
vi.mock("../components/currency-provider", () => ({ useCurrency: () => "KES" }));
vi.mock("../app/(shell)/plan/supply-calendar", () => ({ SupplyCalendarMode: () => null }));
import { PlanView } from "../app/(shell)/plan/plan-view";
import { BudgetPlanner } from "../app/(shell)/plan/budget-planner";
import { BuyChecklist } from "../app/(shell)/plan/buy-checklist";
import { AdvancedMenu } from "../app/(shell)/today/advanced-menu";
import { ProductTabs } from "../app/(shell)/today/product-tabs";
import { ScopeBar } from "../app/(shell)/plan/scope-bar";
import { saveScope } from "../app/(shell)/plan/scope-actions";
import { BuyTable } from "../app/(shell)/plan/buy-table";
import { TableRow } from "../components/ui/table";

type Node = ReactElement<Record<string, unknown>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const list = { forecastRunId: "run1", rows: [], excluded: [], totalPredicted: 0, runDate: new Date(), totalCostKes: 0 } as BuyList;
function view(params: string, run = "run1") {
  state.search = new URLSearchParams(params);
  return nodes(PlanView({ buyList: { ...list, forecastRunId: run }, canBudget: true, canViewCosts: true, canOverride: true, freshness: { kind: "fresh", label: "Fresh" } as never }));
}
beforeEach(() => { state.push.mockClear(); state.refresh.mockClear(); state.setters = []; });
afterEach(() => vi.unstubAllGlobals());

it("mode card clicks preserve filters and urgent deep links", () => {
  const tree = view("class=A&urgent=1");
  const card = tree.find(n => n.props.title === "Start with a budget")!;
  (card.props.onClick as () => void)();
  expect(state.push).toHaveBeenCalledWith("/plan?class=A&urgent=1&mode=budget", { scroll: false });
});
it("urgent toggle updates the shareable URL without losing scope or mode", () => {
  const tree = view("mode=list&class=A&urgent=1");
  const checklist = tree.find(n => n.type === BuyChecklist)!;
  expect(checklist.props.urgentOnly).toBe(true);
  (checklist.props.onUrgentOnlyChange as (next: boolean) => void)(false);
  expect(state.push).toHaveBeenCalledWith("/plan?mode=list&class=A", { scroll: false });
  expect(view("mode=list&class=A").find(n => n.type === BuyChecklist)!.props.urgentOnly).toBe(false);
});
it("budget allocation state is invalidated when scope or forecast changes", () => {
  const key = (params: string, run?: string) => view(params, run).find(n => n.type === BudgetPlanner)!.key;
  expect(key("mode=budget&class=A")).not.toBe(key("mode=budget&class=B"));
  expect(key("mode=budget&class=A")).not.toBe(key("mode=budget&class=A", "run2"));
});
it("hidden selected order rows cannot survive checklist scope or urgency changes", () => {
  const key = (params: string) => view(params).find(n => n.type === BuyChecklist)!.key;
  expect(key("mode=list&class=A")).not.toBe(key("mode=list&class=B"));
  expect(key("mode=list&class=A")).not.toBe(key("mode=list&class=A&urgent=1"));
});

it("each Dashboard KPI and tab selects its advertised product group", () => {
  const empty = { stockout: [], reorder: [], onway: [], dead: [], all: [] };
  const tree = nodes(ProductTabs({ canViewCosts: false, trend: null, data: {
    rows: empty, counts: { stockout: 1, reorder: 2, onway: 3, dead: 4, all: 10 },
    capped: {}, healthy: 4, deadWindowDays: 90, deadStockExport: [], deadCostKes: null,
  } as never }));
  const cards = tree.filter(n => typeof n.props.onSelect === "function");
  expect(cards).toHaveLength(4);
  cards.forEach((card, index) => {
    (card.props.onSelect as () => void)();
    expect(state.setters[0]).toHaveBeenLastCalledWith(["stockout", "reorder", "onway", "dead"][index]);
  });
  for (const tab of Object.keys(empty)) {
    (tree.find(n => n.type === "button" && n.key === tab)!.props.onClick as () => void)();
    expect(state.setters[0]).toHaveBeenLastCalledWith(tab);
  }
});

it.each([
  ["Sync now", "/api/shopify/sync", { enqueued: false }, "A sync is already running."],
  ["Run forecast", "/api/forecast/run", { created: 7 }, "7 products updated"],
])("Dashboard %s calls its endpoint and reports successful completion", async (label, url, body, text) => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
  vi.stubGlobal("fetch", fetchMock);
  const tree = nodes(AdvancedMenu());
  await (tree.find(n => n.type === "button" && n.props.children === label)!.props.onClick as () => Promise<void>)();
  expect(fetchMock).toHaveBeenCalledWith(url, { method: "POST" });
  expect(state.setters[1]).toHaveBeenLastCalledWith({ ok: true, text });
  expect(state.refresh).toHaveBeenCalledOnce();
  expect(state.setters[0]).toHaveBeenLastCalledWith(null);
});

it("Dashboard action failure clears busy state and shows failure without refreshing", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  const tree = nodes(AdvancedMenu());
  await (tree.find(n => n.type === "button" && n.props.children === "Run forecast")!.props.onClick as () => Promise<void>)();
  expect(state.setters[1]).toHaveBeenLastCalledWith({ ok: false, text: expect.stringContaining("Run failed") });
  expect(state.setters[0]).toHaveBeenLastCalledWith(null);
  expect(state.refresh).not.toHaveBeenCalled();
});

it.each([false, true])("saved scope failure produces visible feedback (network failure: %s)", async (networkFailure) => {
  if (networkFailure) vi.mocked(saveScope).mockRejectedValueOnce(new Error("offline"));
  else vi.mocked(saveScope).mockResolvedValueOnce({ ok: false, error: "Delete one saved scope first." });
  const tree = view("mode=list&class=A");
  (tree.find(n => n.type === ScopeBar)!.props.onSaveScope as (name: string) => void)("My list");
  await vi.waitFor(() => expect(state.setters.some(setter => setter.mock.calls.some(([value]) =>
    value === (networkFailure ? "Could not save this scope. Try again." : "Delete one saved scope first.")
  ))).toBe(true));
});

it("quantity editing, checkbox and product link do not also toggle the order row", () => {
  const toggle = vi.fn();
  const tree = nodes(BuyTable({ rows: [{ predictionId: "p1", productId: "product1", title: "Soap", sku: "S1", recommendedQty: 10, moq: 1, runRatePerDay: 1, onHandUnits: 2, onOrderUnits: 0, revenue30dKes: 100, daysLeftToOrder: 1, plannable: "ok" } as never], canViewCosts: true, canOverride: true, picked: new Set(), onToggle: toggle, sort: "plan", onSortChange: vi.fn(), footerTotalKes: 100 }));
  const stopPropagation = vi.fn();
  const quantityCell = tree.find(n => n.type === "div" && typeof n.props.onClick === "function")!;
  (quantityCell.props.onClick as (event: unknown) => void)({ stopPropagation });
  const checkbox = tree.find(n => n.type === "input" && n.props.type === "checkbox")!;
  (checkbox.props.onClick as (event: unknown) => void)({ stopPropagation });
  const productLink = tree.find(n => n.props.href === "/products/product1")!;
  (productLink.props.onClick as (event: unknown) => void)({ stopPropagation });
  expect(stopPropagation).toHaveBeenCalledTimes(3);
  expect(toggle).not.toHaveBeenCalled();
  (checkbox.props.onChange as () => void)();
  expect(toggle).toHaveBeenCalledExactlyOnceWith("p1");
  (tree.find(n => n.type === TableRow)!.props.onClick as () => void)();
  expect(toggle).toHaveBeenCalledTimes(2);
});
