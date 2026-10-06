import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ lock: vi.fn(), plan: vi.fn(), line: vi.fn(), level: vi.fn(), sum: vi.fn(), update: vi.fn(), transaction: vi.fn() }));
vi.mock("@wezesha/db", async () => ({
  ...(await import("../../../packages/db/src/roles")), ...(await import("../../../packages/db/src/inventory")),
  prismaForTenantTx: mocks.transaction,
}));
import { editTransferQuantity } from "../lib/data/transfer-edit";
const tx = { distributionPlan: { updateMany: mocks.lock, findFirst: mocks.plan }, distributionPlanLine: { findFirst: mocks.line, aggregate: mocks.sum, update: mocks.update }, inventoryLevel: { findFirst: mocks.level } };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(async (_tenant: string, work: (db: typeof tx) => Promise<unknown>) => work(tx));
  mocks.lock.mockResolvedValue({ count: 1 });
  mocks.plan.mockResolvedValue({ fromLocationId: "source", fromLocation: { locationType: "warehouse" } });
  mocks.line.mockResolvedValue({ id: "line", productId: "product", qty: 4, toLocationId: "branch", toLocation: { locationType: "branch" }, toOnHand: 2, toRunRate: 2 });
  mocks.level.mockResolvedValue({ available: 10, onHand: 100 });
  mocks.sum.mockResolvedValue({ _sum: { qty: 3 } });
  mocks.update.mockResolvedValue({});
});
const input = { planId: "plan", lineId: "line", qty: 7 };
describe("manual draft transfer quantities", () => {
  it("caps against available, subtracts sibling branches and recalculates saved cover", async () => {
    expect(await editTransferQuantity("tenant", input)).toEqual({ ok: true, previousQty: 4 });
    expect(mocks.lock).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "plan", tenantId: "tenant", status: "draft", deletedAt: null } }));
    expect(mocks.line).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "line", planId: "plan", tenantId: "tenant" } }));
    expect(mocks.sum).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "tenant", planId: "plan", productId: "product", id: { not: "line" } } }));
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: "line" }, data: { qty: 7, toDaysCoverAfter: 4.5 } });
    expect(mocks.lock.mock.invocationCallOrder[0]).toBeLessThan(mocks.line.mock.invocationCallOrder[0]!);
  });
  it("rejects a combined allocation over available even when physical on-hand is higher", async () => {
    expect(await editTransferQuantity("tenant", { ...input, qty: 8 })).toMatchObject({ ok: false });
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it.each([-1, 1.5, NaN, Infinity, 2147483648])("rejects invalid qty %s before starting a transaction", async qty => {
    expect(await editTransferQuantity("tenant", { ...input, qty })).toMatchObject({ ok: false });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("refuses final/deleted/other-tenant plans before reading any lines", async () => {
    mocks.lock.mockResolvedValue({ count: 0 });
    expect(await editTransferQuantity("tenant", input)).toMatchObject({ ok: false });
    expect(mocks.line).not.toHaveBeenCalled();
  });
  it("refuses a line absent from the tenant and plan", async () => {
    mocks.line.mockResolvedValue(null);
    expect(await editTransferQuantity("tenant", input)).toMatchObject({ ok: false });
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("allows clearing stale allocations even after source stock disappears", async () => {
    mocks.level.mockResolvedValue(null);
    expect(await editTransferQuantity("tenant", { ...input, qty: 0 })).toMatchObject({ ok: true });
  });
});
