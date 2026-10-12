import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ permission: vi.fn(), feature: vi.fn(), edit: vi.fn(), audit: vi.fn(), revalidate: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireSession: async () => ({ user: { id: "u", name: "Owner" } }), activeMembership: async () => ({ tenantId: "authorized", displayName: "Owner" }) }));
vi.mock("@/lib/auth/permissions", () => ({ hasPermission: mocks.permission }));
vi.mock("@/lib/capabilities", () => ({ getTenantPlan: async () => "growth", getTenantFeatureOverrides: async () => ({}), planAllows: mocks.feature, planFeatureTier: () => "growth", PLAN_TIER_LABEL: { growth: "Growth" } }));
vi.mock("@wezesha/db", () => ({ prismaService: { auditEvent: { create: mocks.audit } } }));
vi.mock("@/lib/data/transfers", () => ({}));
vi.mock("@/lib/data/transfer-edit", () => ({ editTransferQuantity: mocks.edit }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
import { editTransferLine } from "../app/(shell)/transfers/actions";
beforeEach(() => { vi.clearAllMocks(); mocks.permission.mockReturnValue(true); mocks.feature.mockReturnValue(true); mocks.edit.mockResolvedValue({ ok: true, previousQty: 4 }); });
describe("transfer draft edit action", () => {
  const input = { planId: "plan", lineId: "line", qty: 7 };
  it("uses the session tenant and audits a successful adjustment", async () => {
    expect(await editTransferLine(input)).toMatchObject({ ok: true });
    expect(mocks.edit).toHaveBeenCalledWith("authorized", input);
    expect(mocks.audit).toHaveBeenCalledWith({ data: expect.objectContaining({ tenantId: "authorized", action: "quantity_edited", actorUserId: "u", meta: { lineId: "line", previousQty: 4, qty: 7 } }) });
    expect(mocks.revalidate).toHaveBeenCalledWith("/transfers/plan");
  });
  it("rejects callers without ordering permission", async () => {
    mocks.permission.mockReturnValue(false);
    expect(await editTransferLine(input)).toMatchObject({ ok: false });
    expect(mocks.edit).not.toHaveBeenCalled();
  });
  it("rejects tenants without the transfers feature", async () => {
    mocks.feature.mockReturnValue(false);
    expect(await editTransferLine(input)).toMatchObject({ ok: false });
    expect(mocks.edit).not.toHaveBeenCalled();
  });
});
