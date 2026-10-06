import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const mocks = vi.hoisted(() => ({ load: vi.fn(), allowed: vi.fn(), permission: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireSession: async () => ({ user: { id: "user" } }), activeMembership: async () => ({ tenantId: "my-shop", role: "MEMBER" }) }));
vi.mock("@/lib/auth/permissions", () => ({ hasPermission: mocks.permission }));
vi.mock("@/lib/capabilities", () => ({ getTenantPlan: async () => "GROWTH", getTenantFeatureOverrides: async () => ({}), planAllows: mocks.allowed }));
vi.mock("@/lib/data/transfers", () => ({ getDistributionPlan: mocks.load }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("not found"); } }));
vi.mock("../app/(shell)/transfers/plan-row-actions", () => ({ PlanRowActions: () => <button>Finalise</button> }));
vi.mock("../app/(shell)/transfers/actions", () => ({ editTransferLine: vi.fn() }));
import TransferPlanPage from "../app/(shell)/transfers/[id]/page";
const line = { id: "line1", productId: "p1", sku: "SKU1", title: "Serum", toLocationId: "branch", toLocationName: "Branch One", qty: 7, fromOnHand: 20, toOnHand: 2, toRunRate: 1, toDaysCoverBefore: 2, toDaysCoverAfter: 9, status: "pending", valueKes: null };
beforeEach(() => { vi.clearAllMocks(); mocks.allowed.mockReturnValue(true); mocks.permission.mockReturnValue(false); mocks.load.mockResolvedValue({ id: "saved", name: "Weekly move", status: "draft", fromLocationName: "Warehouse", coverDays: 14, windowDays: 60, units: 7, lines: [line] }); });
describe("saved transfer detail", () => {
  it("loads only the active tenant's saved plan and keeps a member's exports cost-blind", async () => {
    const view = await TransferPlanPage({ params: Promise.resolve({ id: "saved" }) });
    expect(mocks.load).toHaveBeenCalledWith("my-shop", "saved", { canViewCosts: false });
    const html = renderToStaticMarkup(view);
    expect(html).toContain("Send to Branch One");
    expect(html).toContain("60d branch sales window");
    expect(html).toContain("Source stock");
    expect(html).toContain("Export CSV");
    expect(html).not.toContain("Finalise</button>");
    expect(html).not.toContain(">Value</th>");
  });
  it("does not load plan data when the tenant's feature is disabled", async () => {
    mocks.allowed.mockReturnValue(false);
    const view = await TransferPlanPage({ params: Promise.resolve({ id: "other-shop-plan" }) });
    expect(mocks.load).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(view)).toContain("Transfers are not enabled");
  });
  it("returns not found when the scoped loader cannot see that plan", async () => {
    mocks.load.mockResolvedValue(null);
    await expect(TransferPlanPage({ params: Promise.resolve({ id: "other-shop-plan" }) })).rejects.toThrow("not found");
  });
});
